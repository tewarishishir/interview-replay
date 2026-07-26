/**
 * Integration test for `POST /api/profile/parse-resume` and the
 * polling endpoint. We mock the local storage PUT, the job runner publish, and
 * the parse-resume worker helpers so the test is fully deterministic
 * without needing a Postgres-only happy path through the LLM.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

import type * as job runnerModule from "@/job-runner";
import type * as RateLimitModule from "@/lib/rate-limit";

const DEFAULT_HEADERS = {
  origin: "http://localhost:3000",
  "user-agent": "vitest",
};
let headerOverride: Record<string, string> | null = null;
const setHeaders = (h: Record<string, string> | null) => {
  headerOverride = h;
};

vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerOverride ?? DEFAULT_HEADERS),
}));

const mockGetActiveUserId = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getActiveUserId: () => mockGetActiveUserId(),
}));

vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>(
    "@/lib/rate-limit",
  );
  const open = () => ({
    check: vi.fn(async () => ({
      success: true,
      limit: 999,
      remaining: 999,
      reset: Date.now() + 60_000,
    })),
  });
  return {
    ...actual,
    profileWriteLimiter: () => open(),
    resumeParseLimiter: () => open(),
    resumeParsePollLimiter: () => open(),
  };
});

const { mockPutResumeObject, mockDeleteResumeObject, mockEnqueueParseResume } =
  vi.hoisted(() => ({
    mockPutResumeObject: vi.fn(async (..._args: unknown[]) => undefined),
    mockDeleteResumeObject: vi.fn(async (..._args: unknown[]) => undefined),
    mockEnqueueParseResume: vi.fn(async (..._args: unknown[]) => undefined),
  }));

vi.mock("@/lib/storage/resume-put", () => ({
  putResumeObject: mockPutResumeObject,
}));

vi.mock("@/lib/storage/resume-delete", () => ({
  deleteResumeObject: mockDeleteResumeObject,
}));

vi.mock("@/job-runner", async () => {
  const actual = await vi.importActual<typeof job runnerModule>("@/job-runner");
  return {
    ...actual,
    enqueueParseResume: mockEnqueueParseResume,
  };
});

// The route's dev fallback dynamically imports `runParseResumeInline`
// when the job runner publish fails and `JOB_RUNNER_EVENT_KEY` is unset
// (the typical dev / test setup). In test it would otherwise reach
// real `pdf-parse` + LLM provider, which makes the existing rollback
// test assert against unrelated state. We mock it here and default
// to "throws" — that way the existing dispatch-failed test still
// exercises the row-marked-failed + local storage-deleted rollback path. New
// tests can override the mock per-case to assert the dev fallback
// success path.
const mockRunParseResumeInline = vi.fn();
vi.mock("@/lib/profiles/parse-resume-inline", () => ({
  runParseResumeInline: (...args: unknown[]) =>
    mockRunParseResumeInline(...args),
}));

import { POST as POST_PARSE } from "@/app/api/profile/parse-resume/route";
import { GET as GET_PARSE } from "@/app/api/profile/parse-resume/[jobId]/route";
import { GET as GET_PROFILE } from "@/app/api/profile/route";
import { createCredentialsUser } from "@/lib/auth/users";
import { db, schema } from "@/lib/db";
import {
  markResumeParseCompleted,
  markResumeParseFailed,
} from "@/lib/profiles/parse-resume";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  mockGetActiveUserId.mockReset();
  mockPutResumeObject.mockClear();
  mockDeleteResumeObject.mockClear();
  mockEnqueueParseResume.mockClear();
  mockRunParseResumeInline.mockReset();
  // Default: the inline fallback "fails" so the existing
  // dispatch-failed test still exercises the row-marked-failed
  // path. Override per-test (mockResolvedValueOnce) when asserting
  // the dev fallback success path.
  mockRunParseResumeInline.mockRejectedValue(
    new Error("inline_disabled_in_test"),
  );
  setHeaders(null);
});

afterAll(async () => {
  const g = globalThis as { __irPgPool?: { end: () => Promise<void> } };
  await g.__irPgPool?.end();
});

const seedUser = async (email = "alice@example.com") => {
  const result = await createCredentialsUser({
    email,
    password: "password123",
    name: "Alice",
  });
  if (!result.ok) throw new Error(`seedUser failed: ${result.error}`);
  return result.user;
};

/**
 * Build a minimal valid PDF byte stream — just needs the
 * `%PDF-` magic bytes for the route's validator. The job runner
 * worker is mocked so the bytes never touch real pdf-parse.
 */
function buildFakePdf(extraBytes = 1024): File {
  const header = new TextEncoder().encode("%PDF-1.4\n");
  const filler = new Uint8Array(extraBytes);
  const merged = new Uint8Array(header.length + filler.length);
  merged.set(header, 0);
  merged.set(filler, header.length);
  return new File([merged], "resume.pdf", { type: "application/pdf" });
}

function multipartRequest(file: File): Request {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://localhost/api/profile/parse-resume", {
    method: "POST",
    body: form,
  });
}

const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

describe("POST /api/profile/parse-resume — auth", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await POST_PARSE(multipartRequest(buildFakePdf()));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/profile/parse-resume — validation", () => {
  it("rejects when no file is attached", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const form = new FormData();
    const res = await POST_PARSE(
      new Request("http://localhost/api/profile/parse-resume", {
        method: "POST",
        body: form,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-PDF file", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const file = new File([new Uint8Array(100)], "notes.txt", {
      type: "text/plain",
    });
    const res = await POST_PARSE(multipartRequest(file));
    expect(res.status).toBe(400);
  });

  it("rejects a PDF over 5 MB", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const file = buildFakePdf(6 * 1024 * 1024);
    const res = await POST_PARSE(multipartRequest(file));
    expect(res.status).toBe(413);
  });

  it("rejects a fake PDF (no %PDF- magic bytes)", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    const file = new File(
      [new TextEncoder().encode("not a pdf at all")],
      "resume.pdf",
      { type: "application/pdf" },
    );
    const res = await POST_PARSE(multipartRequest(file));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/profile/parse-resume — happy path", () => {
  it("uploads to local storage, inserts the job row, enqueues, and returns 202", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const res = await POST_PARSE(multipartRequest(buildFakePdf()));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.job.status).toBe("pending");
    expect(body.job.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(mockPutResumeObject).toHaveBeenCalledTimes(1);
    expect(mockEnqueueParseResume).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select()
      .from(schema.resumeParseJobs)
      .where(eq(schema.resumeParseJobs.userId, user.id));
    expect(row?.status).toBe("pending");
    expect(row?.s3Key).toMatch(new RegExp(`^resumes/${user.id}/.+\\.pdf$`));
  });

  it("rolls back the job + deletes the local storage object when the publish fails", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);
    mockEnqueueParseResume.mockRejectedValueOnce(new Error("kaboom"));

    const res = await POST_PARSE(multipartRequest(buildFakePdf()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("resume_parse_dispatch_failed");

    expect(mockDeleteResumeObject).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select()
      .from(schema.resumeParseJobs)
      .where(eq(schema.resumeParseJobs.userId, user.id));
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toMatch(/dispatch_failed/);
  });
});

describe("GET /api/profile/parse-resume/:jobId", () => {
  it("returns 401 when not signed in", async () => {
    mockGetActiveUserId.mockResolvedValue(null);
    const res = await GET_PARSE(
      new Request(
        "http://localhost/api/profile/parse-resume/00000000-0000-0000-0000-000000000000",
      ),
      ctx("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the job belongs to another user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");

    mockGetActiveUserId.mockResolvedValue(alice.id);
    const create = await POST_PARSE(multipartRequest(buildFakePdf()));
    const created = await create.json();

    mockGetActiveUserId.mockResolvedValue(bob.id);
    const res = await GET_PARSE(
      new Request(
        `http://localhost/api/profile/parse-resume/${created.job.id}`,
      ),
      ctx(created.job.id),
    );
    expect(res.status).toBe(404);
  });

  it("reflects status changes (pending → completed) made by the worker", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await POST_PARSE(multipartRequest(buildFakePdf()));
    const created = await create.json();

    // Pending → still no draft.
    let res = await GET_PARSE(
      new Request(
        `http://localhost/api/profile/parse-resume/${created.job.id}`,
      ),
      ctx(created.job.id),
    );
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.job.status).toBe("pending");
    expect(body.job.draft).toBeNull();

    // Simulate the worker writing a draft.
    await markResumeParseCompleted({
      jobId: created.job.id,
      userId: user.id,
      draft: {
        years_of_experience: 7,
        current_role: "Senior Engineer",
        professional_summary:
          "Senior backend engineer with 7 years building payments infrastructure.",
        companies: [
          {
            name: "Stripe",
            role: "Senior Engineer",
            time_period: "2020-2024",
            description: "Owned the ledger reconciliation service.",
          },
        ],
        technologies: [
          { name: "TypeScript", years_used: 6, proficiency: "expert" },
        ],
        education: [
          {
            degree: "B.S.",
            institution: "MIT",
            year: 2017,
            field: "Computer Science",
          },
        ],
      },
    });

    res = await GET_PARSE(
      new Request(
        `http://localhost/api/profile/parse-resume/${created.job.id}`,
      ),
      ctx(created.job.id),
    );
    body = await res.json();
    expect(body.job.status).toBe("completed");
    expect(body.job.draft.current_role).toBe("Senior Engineer");
    expect(body.job.draft.companies).toHaveLength(1);
  });

  it("surfaces failure state with errorMessage", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await POST_PARSE(multipartRequest(buildFakePdf()));
    const created = await create.json();

    await markResumeParseFailed({
      jobId: created.job.id,
      userId: user.id,
      errorMessage: "resume_parse_invalid_output: bad JSON",
    });

    const res = await GET_PARSE(
      new Request(
        `http://localhost/api/profile/parse-resume/${created.job.id}`,
      ),
      ctx(created.job.id),
    );
    const body = await res.json();
    expect(body.job.status).toBe("failed");
    expect(body.job.errorMessage).toMatch(/invalid_output/);
  });
});

describe("PATCH /api/profile after parse — full save flow", () => {
  it("the user can commit a draft via PATCH /api/profile and read it back", async () => {
    const user = await seedUser();
    mockGetActiveUserId.mockResolvedValue(user.id);

    const create = await POST_PARSE(multipartRequest(buildFakePdf()));
    const created = await create.json();

    await markResumeParseCompleted({
      jobId: created.job.id,
      userId: user.id,
      draft: {
        years_of_experience: 9,
        current_role: "Staff Engineer",
        professional_summary:
          "Staff engineer with 9 years on payments and ledger systems.",
        companies: [
          {
            name: "Stripe",
            role: "Staff Engineer",
            time_period: "2022-2024",
            description: "Tech lead for ledger v2; cut latency by 40%.",
          },
        ],
        technologies: [
          { name: "Go", years_used: 5, proficiency: "expert" },
        ],
        education: [],
      },
    });

    // Read the draft (mimics the polling success).
    const job = await GET_PARSE(
      new Request(
        `http://localhost/api/profile/parse-resume/${created.job.id}`,
      ),
      ctx(created.job.id),
    );
    const { job: jobBody } = await job.json();
    expect(jobBody.draft.current_role).toBe("Staff Engineer");

    // Commit via PATCH /api/profile.
    const { PATCH } = await import("@/app/api/profile/route");
    const commit = await PATCH(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          yearsOfExperience: jobBody.draft.years_of_experience,
          currentRole: jobBody.draft.current_role,
          professionalSummary: jobBody.draft.professional_summary,
          companies: jobBody.draft.companies,
          technologies: jobBody.draft.technologies,
          education: jobBody.draft.education,
          markResumeSaved: true,
        }),
      }),
    );
    expect(commit.status).toBe(200);

    const res = await GET_PROFILE();
    const body = await res.json();
    expect(body.profile.yearsOfExperience).toBe(9);
    expect(body.profile.currentRole).toBe("Staff Engineer");
    expect(body.profile.professionalSummary).toContain("Staff engineer");
    expect(body.profile.companies).toHaveLength(1);
    expect(body.profile.companies[0].description).toContain("ledger v2");
    expect(body.profile.resumeSavedAt).not.toBeNull();
  });
});
