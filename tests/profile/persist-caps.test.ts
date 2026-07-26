/**
 * Unit tests for the persistence helpers — specifically the
 * cap enforcement and status-pin guarantees added in the
 * post-review hardening pass.
 *
 * These run against the real database (same shape as the route
 * tests) because the bugs they guard against only manifest under
 * Postgres semantics (advisory locks, concurrent transactions,
 * conditional UPDATEs).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { db, schema } from "@/lib/db";
import { createCredentialsUser } from "@/lib/auth/users";
import {
  createProject,
  createStory,
  ProjectsLimitExceededError,
  StoriesLimitExceededError,
} from "@/lib/profiles/persist";
import {
  loadResumeParseJob,
  markResumeParseCompleted,
  markResumeParseFailed,
  markResumeParseProcessing,
  ResumeParseJobNotFoundError,
} from "@/lib/profiles/parse-resume";

import { ensureSchema, resetDatabase } from "../db/helpers";

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
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

const insertResumeParseJob = async (userId: string, s3Key: string) => {
  const [row] = await db
    .insert(schema.resumeParseJobs)
    .values({ userId, s3Key, status: "pending" })
    .returning();
  if (!row) throw new Error("insertResumeParseJob: no row returned");
  return row;
};

describe("createProject — cap is hard, not soft", () => {
  it("rejects the (limit+1)th sequential insert with ProjectsLimitExceededError", async () => {
    const user = await seedUser();
    for (let i = 0; i < 3; i++) {
      await createProject({
        userId: user.id,
        data: { name: `Project ${i}` },
        limit: 3,
      });
    }
    await expect(
      createProject({
        userId: user.id,
        data: { name: "Project 4" },
        limit: 3,
      }),
    ).rejects.toBeInstanceOf(ProjectsLimitExceededError);
  });

  it("does not exceed the cap under concurrent inserts (advisory lock)", async () => {
    // Without the per-user advisory lock, two READ COMMITTED
    // transactions can each see count=0 and each insert, leaving
    // 2 rows for a cap of 1. The lock serializes the
    // count-then-insert window so only the first writer wins.
    const user = await seedUser();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        createProject({
          userId: user.id,
          data: { name: `Project ${i}` },
          limit: 1,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(
        r.status === "rejected" && r.reason instanceof ProjectsLimitExceededError,
      ).toBe(true);
    }

    const rows = await db.select().from(schema.projects);
    expect(rows).toHaveLength(1);
  });
});

describe("createStory — per-user cap", () => {
  it("rejects the (limit+1)th sequential insert with StoriesLimitExceededError", async () => {
    const user = await seedUser();
    for (let i = 0; i < 2; i++) {
      await createStory({
        userId: user.id,
        data: { theme: "leadership_conflict", title: `Story ${i}` },
        limit: 2,
      });
    }
    await expect(
      createStory({
        userId: user.id,
        data: { theme: "biggest_failure", title: "Story 3" },
        limit: 2,
      }),
    ).rejects.toBeInstanceOf(StoriesLimitExceededError);
  });

  it("does not exceed the cap under concurrent inserts", async () => {
    const user = await seedUser();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        createStory({
          userId: user.id,
          data: {
            theme: "leadership_conflict",
            title: `Story ${i}`,
          },
          limit: 1,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rows = await db.select().from(schema.stories);
    expect(rows).toHaveLength(1);
  });
});

describe("resume_parse_jobs — status pin + userId pin", () => {
  it("loadResumeParseJob is userId-scoped (mismatched user is treated as not-found)", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const job = await insertResumeParseJob(alice.id, "resumes/alice/x.pdf");

    await expect(loadResumeParseJob(job.id, bob.id)).rejects.toBeInstanceOf(
      ResumeParseJobNotFoundError,
    );

    const ok = await loadResumeParseJob(job.id, alice.id);
    expect(ok.id).toBe(job.id);
  });

  it("markResumeParseProcessing returns false (no-op) for the wrong user", async () => {
    const alice = await seedUser("alice@example.com");
    const bob = await seedUser("bob@example.com");
    const job = await insertResumeParseJob(alice.id, "resumes/alice/x.pdf");

    const updated = await markResumeParseProcessing(job.id, bob.id);
    expect(updated).toBe(false);

    const reloaded = await loadResumeParseJob(job.id, alice.id);
    expect(reloaded.status).toBe("pending");
    expect(reloaded.attempts).toBe(0);
  });

  it("markResumeParseFailed returns false (and does NOT regress) when the job is already completed", async () => {
    const alice = await seedUser();
    const job = await insertResumeParseJob(alice.id, "resumes/alice/x.pdf");

    const completed = await markResumeParseCompleted({
      jobId: job.id,
      userId: alice.id,
      draft: {
        years_of_experience: 5,
        current_role: "Senior",
        professional_summary: null,
        companies: [],
        technologies: [],
        education: [],
      },
    });
    expect(completed).toBe(true);

    const failed = await markResumeParseFailed({
      jobId: job.id,
      userId: alice.id,
      errorMessage: "late onFailure callback",
    });
    expect(failed).toBe(false);

    const reloaded = await loadResumeParseJob(job.id, alice.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.errorMessage).toBeNull();
  });

  it("markResumeParseCompleted returns false when the job is already failed (no draft overwrite)", async () => {
    const alice = await seedUser();
    const job = await insertResumeParseJob(alice.id, "resumes/alice/x.pdf");

    const failed = await markResumeParseFailed({
      jobId: job.id,
      userId: alice.id,
      errorMessage: "early failure",
    });
    expect(failed).toBe(true);

    const completed = await markResumeParseCompleted({
      jobId: job.id,
      userId: alice.id,
      draft: {
        years_of_experience: 5,
        current_role: "Senior",
        professional_summary: null,
        companies: [],
        technologies: [],
        education: [],
      },
    });
    expect(completed).toBe(false);

    const reloaded = await loadResumeParseJob(job.id, alice.id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.draftJson).toBeNull();
  });
});
