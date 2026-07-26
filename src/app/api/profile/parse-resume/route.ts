import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { enqueueJob } from "@/lib/jobs";
import { getActiveUserId } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { toResumeParseJobDto } from "@/lib/profiles/dto";
import {
  markResumeParseFailed,
  ResumeParseLlmNotConfiguredError,
} from "@/lib/profiles/parse-resume";
import {
  RESUME_MAX_BYTES,
  RESUME_MIME_TYPES,
} from "@/lib/profiles/schemas";
import { resumeParseLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { StorageNotConfiguredError } from "@/lib/storage";
import { deleteFile } from "@/lib/storage/delete";
import { resumeKey } from "@/lib/storage/keys";
import { writeFile } from "@/lib/storage/write";

/**
 * `POST /api/profile/parse-resume`
 *
 * Accepts a multipart upload (`file` field, application/pdf, max
 * 5 MB) and kicks off the async parse pipeline:
 *
 *   1. Same-origin / auth / rate-limit gate (10 calls/hour).
 *   2. Multipart parse + size + MIME + magic-bytes validation.
 *   3. Push the PDF to storage under `resumes/{userId}/{uuid}.pdf`.
 *   4. Insert a `resume_parse_jobs` row in `pending` state.
 *   5. Run the resume parse pipeline inline (fire-and-forget).
 *   6. If the publish fails, the row is flipped to `failed` AND
 *      the stored file is best-effort deleted so the user gets a
 *      clear error and we don't leave orphaned PDFs.
 *
 * Returns 202 + the freshly-minted job DTO so the frontend can
 * start polling immediately.
 *
 * Why server-side multipart instead of presigned PUT:
 *   - The candidate's PDF is small (5 MB cap), so the cost of
 *     proxying through Next is negligible compared to the latency
 *     win of starting the worker in the same request.
 *   - We get to validate magic bytes BEFORE the PDF touches storage.
 *   - The 5-step gate is simpler than a two-call presign dance
 *     and the rate-limit budget covers reasonable usage.
 */

export const runtime = "nodejs";

const HARD_BODY_CAP = RESUME_MAX_BYTES + 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  const h = await headers();

  if (!isSameOrigin(h)) {
    return NextResponse.json(
      { error: "forbidden", message: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  const limit = await resumeParseLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "You've parsed several resumes recently. Try again in a bit.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > HARD_BODY_CAP) {
    return NextResponse.json(
      {
        error: "payload_too_large",
        message: `Resume must be ${RESUME_MAX_BYTES / (1024 * 1024)} MB or smaller.`,
      },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.warn("[POST /api/profile/parse-resume] formData parse failed:", err);
    return NextResponse.json(
      { error: "bad_request", message: "Could not read the uploaded file." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Attach the resume PDF as the `file` field.",
      },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { error: "validation_failed", message: "Uploaded file is empty." },
      { status: 400 },
    );
  }

  if (file.size > RESUME_MAX_BYTES) {
    return NextResponse.json(
      {
        error: "payload_too_large",
        message: `Resume must be ${RESUME_MAX_BYTES / (1024 * 1024)} MB or smaller.`,
      },
      { status: 413 },
    );
  }

  // Browsers occasionally upload PDFs with `application/octet-stream`,
  // so accept the .pdf extension as a fallback. The magic-bytes
  // check below is the real authority.
  const declaredType = (file.type || "").toLowerCase();
  const looksLikePdf =
    (RESUME_MIME_TYPES as readonly string[]).includes(declaredType) ||
    file.name.toLowerCase().endsWith(".pdf");
  if (!looksLikePdf) {
    return NextResponse.json(
      { error: "validation_failed", message: "Only PDF files are accepted." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0 || !looksLikeRealPdf(bytes)) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "The uploaded file is not a valid PDF.",
      },
      { status: 400 },
    );
  }

  let key: string;
  try {
    key = resumeKey(userId);
  } catch (err) {
    console.error("[POST /api/profile/parse-resume] resumeKey:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not allocate upload key." },
      { status: 500 },
    );
  }

  try {
    await writeFile(key, bytes);
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      return NextResponse.json(
        {
          error: err.code,
          message:
            "Resume upload isn't configured in this environment. Contact the operator.",
        },
        { status: err.status },
      );
    }
    console.error("[POST /api/profile/parse-resume] storage write failed:", err);
    return NextResponse.json(
      { error: "internal_error", message: "Could not upload the resume." },
      { status: 500 },
    );
  }

  let jobId: string;
  try {
    const [row] = await db
      .insert(schema.resumeParseJobs)
      .values({ userId, s3Key: key, status: "pending" })
      .returning({ id: schema.resumeParseJobs.id });
    if (!row) {
      throw new Error("resume_parse_jobs INSERT returned no row");
    }
    jobId = row.id;
  } catch (err) {
    console.error("[POST /api/profile/parse-resume] DB insert failed:", err);
    try {
      await deleteFile(key);
    } catch (cleanupErr) {
      console.error(
        "[POST /api/profile/parse-resume] cleanup after DB insert failed:",
        cleanupErr,
      );
    }
    return NextResponse.json(
      { error: "internal_error", message: "Could not start resume parsing." },
      { status: 500 },
    );
  }

  // Run the parse pipeline inline (fire-and-forget for the heavy
  // LLM work). We already have the PDF bytes in memory.
  void enqueueJob("parse-resume", async () => {
    const { runParseResumeInline } = await import(
      "@/lib/profiles/parse-resume-inline"
    );
    await runParseResumeInline({ jobId, userId, s3Key: key, bytes });
  });

  // Read the freshly-inserted row so we can return the canonical
  // DTO shape (timestamps + status + status-aware draft).
  const [row] = await db
    .select()
    .from(schema.resumeParseJobs)
    .where(eq(schema.resumeParseJobs.id, jobId));
  if (!row) {
    return NextResponse.json(
      { error: "internal_error", message: "Could not load the new job." },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { job: toResumeParseJobDto(row) },
    { status: 202 },
  );
}

/**
 * Magic-number check. Real PDFs start with `%PDF-` per the spec.
 * Some converters prepend a BOM or a few bytes of whitespace, so
 * we scan the first 1024 bytes rather than enforcing position 0.
 */
function looksLikeRealPdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i < head.length - 4; i++) {
    if (
      head[i] === 0x25 && // %
      head[i + 1] === 0x50 && // P
      head[i + 2] === 0x44 && // D
      head[i + 3] === 0x46 && // F
      head[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}
