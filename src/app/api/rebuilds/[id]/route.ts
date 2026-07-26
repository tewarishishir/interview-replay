import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import { rebuildWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  discardRebuild,
  getRebuild,
  patchRebuild,
  patchRebuildBodySchema,
  toRebuildDto,
} from "@/lib/rebuilds";

/**
 * /api/rebuilds/:id — read, update, soft-delete.
 *
 *   GET    fetch one rebuild (404 for not-owned-or-not-found).
 *   PATCH  partial update; auto-saves the candidate's draft.
 *          Empty bodies rejected to avoid no-op audit noise.
 *   DELETE soft-delete (status='discarded'); idempotent.
 *
 * Same preflight pattern as outcomes: same-origin, active user,
 * rate limit, ownership-pinned read.
 */

const MAX_BODY_BYTES = 32 * 1024;

const paramsSchema = z.object({ id: z.uuid() });
type RouteContext = { params: Promise<{ id: string }> };

const FORBIDDEN = (): Response =>
  NextResponse.json(
    { error: "forbidden", message: "Cross-origin request rejected." },
    { status: 403 },
  );
const UNAUTHORIZED = (): Response =>
  NextResponse.json(
    { error: "unauthorized", message: "You must be signed in." },
    { status: 401 },
  );
const NOT_FOUND = (): Response =>
  NextResponse.json(
    { error: "not_found", message: "Rebuild not found." },
    { status: 404 },
  );

/**
 * 409 used when a write is rejected because the rebuild is in a
 * non-mutable state — `saved_to_bank` (canonical record is now the
 * promoted story) or `discarded` (soft-deleted, awaiting purge).
 * The route surfaces this distinctly from 404 so the client can
 * decide whether to refresh-and-retry or surface a specific error.
 */
const WRONG_STATE = (action: string): Response =>
  NextResponse.json(
    {
      error: "rebuild_wrong_state",
      message: `This rebuild can no longer be ${action} — it has been saved to your story bank or discarded.`,
    },
    { status: 409 },
  );

interface PreflightOk {
  ok: true;
  userId: string;
  rebuildId: string;
}
type PreflightResult = PreflightOk | { ok: false; response: Response };

async function preflight(
  context: RouteContext,
  opts: { rateLimit: boolean },
): Promise<PreflightResult> {
  const h = await headers();
  if (!isSameOrigin(h)) return { ok: false, response: FORBIDDEN() };

  const userId = await getActiveUserId();
  if (!userId) return { ok: false, response: UNAUTHORIZED() };

  if (opts.rateLimit) {
    const rl = rebuildWriteLimiter();
    const limit = await rl.check(userId);
    if (!limit.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((limit.reset - Date.now()) / 1000),
      );
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "rate_limited",
            message: "Too many rebuild edits. Try again shortly.",
            retryAfter,
          },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        ),
      };
    }
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return { ok: false, response: NOT_FOUND() };

  return {
    ok: true,
    userId,
    rebuildId: parsedParams.data.id,
  };
}

/* ──────────────────────────────────────────────────────────── */
/*                              GET                              */
/* ──────────────────────────────────────────────────────────── */

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(context, { rateLimit: false });
  if (!pre.ok) return pre.response;

  const row = await getRebuild(pre.rebuildId, pre.userId);
  if (!row) return NOT_FOUND();

  return NextResponse.json(
    { rebuild: toRebuildDto(row) },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/* ──────────────────────────────────────────────────────────── */
/*                             PATCH                             */
/* ──────────────────────────────────────────────────────────── */

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(context, { rateLimit: true });
  if (!pre.ok) return pre.response;

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body is too large." },
      { status: 413 },
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body could not be read." },
      { status: 400 },
    );
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "payload_too_large", message: "Request body is too large." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { error: "bad_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = patchRebuildBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "Body is invalid.",
        fieldErrors: Object.fromEntries(
          parsed.error.issues.map((i) => [
            i.path.map(String).join(".") || "_form",
            i.message,
          ]),
        ),
      },
      { status: 400 },
    );
  }

  // Reject empty bodies (a stuck client sending an empty PATCH is
  // either an autosave bug or a misfire — surfacing it 400 is more
  // useful than silently writing a no-op).
  const hasAnyKey = Object.values(parsed.data).some((v) => v !== undefined);
  if (!hasAnyKey) {
    return NextResponse.json(
      {
        error: "validation_failed",
        message: "PATCH body had no fields to update.",
      },
      { status: 400 },
    );
  }

  const result = await patchRebuild({
    rebuildId: pre.rebuildId,
    userId: pre.userId,
    patch: parsed.data,
  });
  if (!result.ok) {
    return result.reason === "wrong_state"
      ? WRONG_STATE("edited")
      : NOT_FOUND();
  }

  return NextResponse.json(
    { rebuild: toRebuildDto(result.row) },
    { status: 200, headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/* ──────────────────────────────────────────────────────────── */
/*                            DELETE                             */
/* ──────────────────────────────────────────────────────────── */

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const pre = await preflight(context, { rateLimit: true });
  if (!pre.ok) return pre.response;

  const result = await discardRebuild({
    rebuildId: pre.rebuildId,
    userId: pre.userId,
  });
  if (!result.ok) {
    return result.reason === "wrong_state"
      ? WRONG_STATE("discarded")
      : NOT_FOUND();
  }

  trackServerEvent({
    distinctId: pre.userId,
    event: ANALYTICS_EVENTS.rebuildDiscarded,
    properties: {},
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
