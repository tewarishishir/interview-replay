import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";
import { getActiveUserId } from "@/lib/auth/session";
import { rebuildWriteLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";
import {
  RebuildAlreadyPromotedError,
  RebuildDiscardedError,
  RebuildNotReadyToSaveError,
  RebuildVanishedError,
  StoryBankLimitExceededError,
  getRebuild,
  saveRebuildToBank,
  toSavedToBankDto,
} from "@/lib/rebuilds";
import { saveToBankBodySchema } from "@/lib/rebuilds/schemas";

/**
 * POST /api/rebuilds/:id/save-to-bank
 *
 * Promote the rebuild's draft to a permanent `stories` row.
 * Idempotent in the sense that a re-POST on an already-promoted
 * rebuild returns 409 (the original promotion stands); we don't
 * silently no-op because the user clicked "Save to story bank"
 * a second time and is owed an honest answer about whether their
 * action took effect.
 */

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

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) return FORBIDDEN();

  const userId = await getActiveUserId();
  if (!userId) return UNAUTHORIZED();

  const limit = await rebuildWriteLimiter().check(userId);
  if (!limit.success) {
    const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many rebuild edits. Try again shortly.",
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return NOT_FOUND();

  // Body is now optional. The critique-step "Save to story bank"
  // CTA still sends `{ theme }` from its dedicated `<Select>`,
  // which is the user-controlled bucketing path. The scaffold-step
  // "Save without critique" shortcut sends an empty body and the
  // server falls back to `mapRebuildThemeToStoryTheme(rebuild.questionTheme)`
  // inside `saveRebuildToBank` — which itself defaults to "Other"
  // when questionTheme is null. The user can re-bucket from the
  // story bank in either case.
  let rawBody: unknown = null;
  try {
    const text = await request.text();
    rawBody = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsedBody = saveToBankBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsedBody.error.issues) {
      const key = issue.path.join(".") || "root";
      fieldErrors[key] = issue.message;
    }
    return NextResponse.json(
      {
        error: "bad_request",
        message: "Invalid save-to-bank request.",
        fieldErrors,
      },
      { status: 400 },
    );
  }

  // Ownership pre-check (before holding the per-user advisory
  // lock inside the transaction). A 404 here keeps an attacker
  // from probing rebuild ids; the canonical lifecycle checks
  // (already-promoted / discarded / vanished) all live inside
  // `saveRebuildToBank`'s transaction so they're race-safe.
  const rebuild = await getRebuild(parsedParams.data.id, userId);
  if (!rebuild) return NOT_FOUND();

  try {
    const result = await saveRebuildToBank({
      rebuildId: parsedParams.data.id,
      userId,
      theme: parsedBody.data.theme,
    });

    trackServerEvent({
      distinctId: userId,
      event: ANALYTICS_EVENTS.rebuildSavedToBank,
      properties: {
        theme: result.story.theme,
        // The pre-check `rebuild` snapshot is fine for these
        // analytics dimensions — they're observational signals
        // about the user's path, not authoritative state.
        had_critique: rebuild.aiCritiqueJson != null,
        had_source_session: rebuild.sourceSessionId != null,
      },
    });

    return NextResponse.json(toSavedToBankDto(result), {
      status: 201,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    });
  } catch (err) {
    if (err instanceof RebuildAlreadyPromotedError) {
      return NextResponse.json(
        {
          error: "rebuild_already_promoted",
          message: "This rebuild has already been saved to your story bank.",
        },
        { status: 409 },
      );
    }
    if (err instanceof RebuildDiscardedError) {
      return NextResponse.json(
        {
          error: "rebuild_discarded",
          message:
            "This rebuild has been discarded and can't be saved to the story bank. Start a new rebuild instead.",
        },
        { status: 409 },
      );
    }
    if (err instanceof RebuildVanishedError) {
      // Rebuild deleted concurrently between the route's
      // pre-check and the transaction. 404 keeps the surface
      // honest about what's actually behind the URL now.
      return NOT_FOUND();
    }
    if (err instanceof RebuildNotReadyToSaveError) {
      return NextResponse.json(
        {
          error: "rebuild_not_ready_to_save",
          message:
            "Fill in your headline and at least one of Situation/Task/Action/Result before saving.",
          missing: err.missing,
        },
        { status: 400 },
      );
    }
    if (err instanceof StoryBankLimitExceededError) {
      return NextResponse.json(
        {
          error: err.code,
          message: `Your story bank is full (${err.limit} stories). Delete one to save another.`,
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
