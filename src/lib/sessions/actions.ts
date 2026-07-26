"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getActiveUserId } from "@/lib/auth/session";
import { ipFromHeaders, sessionCreateLimiter } from "@/lib/rate-limit";
import { isSameOrigin } from "@/lib/same-origin";

import { createSession } from "./create";
import {
  createSessionPayloadSchema,
  type CreateSessionPayload,
} from "./schemas";

/**
 * Server action wrapping `createSession` for direct use from the
 * `/sessions/new` form. The form posts to this rather than to
 * `/api/sessions` so the (a) auth check is in-process, (b) the post-
 * create redirect happens in one round trip, and (c) we can use
 * `useTransition` on the client for pending UI without writing our
 * own fetch wrapper.
 *
 * The pipeline mirrors the API route exactly — auth → rate-limit →
 * Zod → DB write — so a payload that succeeds via the action would
 * also succeed via `POST /api/sessions`, and vice versa. That's by
 * design: drift between the two paths is a security tax we don't
 * want to pay.
 *
 * Discriminated return so the client can branch on `state`. We
 * never throw out of this action for user-facing failures: the
 * form needs to render field-level errors, and Next surfaces thrown
 * errors as generic 500s with no structured payload.
 *
 * On success the server-side `redirect("/sessions/[id]/record")`
 * ends the action by throwing `NEXT_REDIRECT`; React's
 * `useActionState` never sees the success branch in practice. We
 * still return one for completeness and so the type stays sound.
 */

export type CreateSessionActionState =
  | { state: "idle" }
  | {
      state: "error";
      formError?: string;
      fieldErrors?: Record<string, string>;
    }
  | { state: "success"; sessionId: string };

const INITIAL_STATE: CreateSessionActionState = { state: "idle" };

/**
 * Plain object the React form passes to the action. Using a plain
 * object (instead of FormData) keeps the wire shape identical to the
 * `/api/sessions` JSON body, so the same payload validates the same
 * way against the same schema in both code paths.
 */
export async function createSessionAction(
  _prev: CreateSessionActionState = INITIAL_STATE,
  payload: CreateSessionPayload,
): Promise<CreateSessionActionState> {
  // Same-origin guard. Next.js 15 server actions already enforce an
  // Origin/Host check internally, but we re-run our explicit guard
  // here so:
  //   1. The action and the `/api/sessions` API route share one
  //      contract — what's accepted on one is accepted on the other.
  //   2. A future Next.js change that loosens the built-in check
  //      can't silently re-open this surface to CSRF.
  const h = await headers();
  if (!isSameOrigin(h)) {
    return {
      state: "error",
      formError: "Cross-origin request rejected.",
    };
  }

  // Active-user check (JWT + DB revocation in one). The (app)
  // layout already runs this for page renders; we duplicate it
  // here because server actions don't traverse layouts.
  const userId = await getActiveUserId();
  if (!userId) {
    return {
      state: "error",
      formError: "You must be signed in to start a session.",
    };
  }

  // Per-user rate limit. 30/hour is generous for a real candidate
  // and tight enough that a stuck retry loop or a stolen JWT can't
  // run away with the audit table.
  const limiter = sessionCreateLimiter();
  const limit = await limiter.check(userId);
  if (!limit.success) {
    const retrySeconds = Math.max(
      1,
      Math.ceil((limit.reset - Date.now()) / 1000),
    );
    return {
      state: "error",
      formError: `Too many sessions started recently. Try again in ${retrySeconds}s.`,
    };
  }

  const parsed = createSessionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
    return { state: "error", fieldErrors };
  }

  const { companyName, roleTitle, level, roundType, scheduledAt } = parsed.data;

  const ipAddress = ipFromHeaders(h);
  const userAgent = h.get("user-agent");

  let row: Awaited<ReturnType<typeof createSession>>;
  try {
    row = await createSession({
      userId,
      companyName,
      roleTitle,
      level,
      roundType,
      scheduledAt: scheduledAt ?? null,
      ipAddress: ipAddress === "unknown-ip" ? null : ipAddress,
      userAgent,
    });
  } catch (err) {
    console.error("[createSessionAction] insert failed:", err);
    return {
      state: "error",
      formError: "Could not create your session. Please try again.",
    };
  }

  // `redirect` throws NEXT_REDIRECT — Next.js consumes it and the
  // browser ends up on the record page. The fall-through return
  // statement below is unreachable in practice; it's there so the
  // TypeScript type stays a discriminated union without a `never`
  // narrowing dance on the caller side.
  redirect(`/sessions/${row.id}/record`);
}
