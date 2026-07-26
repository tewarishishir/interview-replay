import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getActiveUserId } from "@/lib/auth/session";
import {
  enqueueExportRow,
  findInFlightExport,
  getLatestReadyExport,
  presignExportDownload,
} from "@/lib/compliance";
import { db, schema } from "@/lib/db";
import { features } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";
import { dataExportRequestLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import { eq } from "drizzle-orm";

/**
 * /api/me/export — GDPR data-portability endpoints.
 *
 *   GET  : returns the latest export's status + download link
 *          (when ready). Used by the account page to render the
 *          "Download my data" tile.
 *
 *   POST : enqueues a new export. Idempotent: a request while one
 *          is already in flight returns the in-flight row instead
 *          of fanning out to a second worker.
 *
 * Spec calls this `GET /api/me/export → trigger background job`.
 * We split the verbs because:
 *
 *   - "trigger work" is a side effect; it should be POST per HTTP
 *     semantics (and per Next.js's CSRF middleware default).
 *   - "tell me the latest export status" is genuinely a GET.
 *
 * The dashboard page calls GET to render state and POST to kick
 * off a new export.
 */

export async function GET(): Promise<Response> {
  const userId = await getActiveUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized", message: "You must be signed in." },
      { status: 401 },
    );
  }

  // The latest exports are read-mostly + rate-bounded by the user
  // having to wait 7 days for a TTL — no rate limit needed beyond
  // the auth gate.
  const inFlight = await findInFlightExport(userId);
  const latest = await getLatestReadyExport(userId);

  let downloadUrl: string | null = null;
  let downloadExpiresAt: string | null = null;
  if (latest) {
    try {
      const presigned = await presignExportDownload({ s3Key: latest.s3Key });
      downloadUrl = presigned.url;
      downloadExpiresAt = presigned.expiresAt.toISOString();
    } catch (err) {
      // Don't fail the GET — surface the row state and let the
      // user see "ready but download link unavailable" rather than
      // a 500. Most often this is "storage not configured" in dev.
      console.error("[/api/me/export GET] presign failed:", err);
    }
  }

  return NextResponse.json(
    {
      inFlight: inFlight ? { id: inFlight.id, status: inFlight.status } : null,
      latest: latest
        ? {
            id: latest.id,
            expiresAt: latest.expiresAt.toISOString(),
            completedAt: latest.completedAt?.toISOString() ?? null,
            fileSizeBytes: latest.fileSizeBytes,
            downloadUrl,
            downloadExpiresAt,
          }
        : null,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

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

  // Exports are expensive (full-account ZIP, storage upload, transactional
  // email). Bounce abusive callers BEFORE the worker fan-out.
  const limit = await dataExportRequestLimiter().check(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "You've requested several exports recently. Please try again later.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  if (!features.audioStorage) {
    // The export ZIP needs storage — refuse gracefully in dev so the UI
    // can render a "exports unavailable in this environment"
    // message rather than crashing. Keeping the 503 here (instead
    // of letting the worker fail mid-flight) means we never write
    // a `pending` row that will instantly transition to `failed`.
    return NextResponse.json(
      {
        error: "service_unavailable",
        message:
          "Data exports require object storage to be configured. Try again later.",
      },
      { status: 503 },
    );
  }

  /* 1. Idempotency: if there's already a pending/building export,
        return that. */
  const inFlight = await findInFlightExport(userId);
  if (inFlight) {
    return NextResponse.json(
      { ok: true, exportId: inFlight.id, alreadyInFlight: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  /* 2. Insert the row + enqueue the worker. We do these in
        sequence (not parallel) so a failed enqueue doesn't leave
        a permanent `pending` row stuck in the dashboard.

        `enqueueExportRow` is race-safe: a concurrent POST that
        raced past our `findInFlightExport` check trips the partial
        unique index and gets back `existed: true`. In that case we
        skip the job dispatch — the original request's worker
        is already on it. */
  const row = await enqueueExportRow({ userId });

  if (row.existed) {
    return NextResponse.json(
      { ok: true, exportId: row.id, alreadyInFlight: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }

  void enqueueJob("export-user-data", async () => {
    const { runExportUserData } = await import("@/lib/compliance/export");
    await runExportUserData({ exportId: row.id, userId });
  });

  void request;

  return NextResponse.json(
    { ok: true, exportId: row.id },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
