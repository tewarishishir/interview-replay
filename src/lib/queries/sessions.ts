import "server-only";

import { cache } from "react";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  InterviewSession,
  InterviewRoundType,
  InterviewSessionState,
  OutcomeType,
} from "@/lib/db/schema";

const ACTIVE_USER = isNull(schema.users.deletedAt);

/**
 * Read-side queries for the `interview_sessions` table.
 *
 * Every query takes `userId` and pins the WHERE on it. We never expose a
 * "by id only" lookup — that's how cross-tenant data leaks happen. The
 * dashboard, the per-session page, and any future API route should all
 * funnel through here so the ownership filter is impossible to skip.
 */

/**
 * Slim row for the dashboard list — just enough to render a card and
 * link to the detail page. Keep this narrow so we don't accidentally
 * over-fetch when the table grows columns later.
 */
export interface SessionListItem {
  id: string;
  companyName: string;
  roleTitle: string;
  level: string;
  roundType: InterviewRoundType;
  state: InterviewSessionState;
  scheduledAt: Date | null;
  createdAt: Date;
  /**
   * Outcome the user has recorded for this session. NULL when no
   * outcome row exists. The dashboard card renders one of three
   * states based on this:
   *   - non-null  → colored outcome badge
   *   - null + session > 7 days old → "Record outcome →" prompt
   *   - null + session ≤ 7 days old → nothing (don't pressure too
   *     early; the user may not have heard back yet)
   *
   * Pulled with a LEFT JOIN against `session_outcomes` so the
   * dashboard query stays one round-trip even as the table grows.
   */
  outcomeType: OutcomeType | null;
}

const SOFT_DELETE_FILTER = isNull(schema.interviewSessions.deletedAt);

/**
 * List the user's most recent interview sessions, newest first.
 * Soft-deleted rows are filtered out at the query layer.
 *
 * Hits the partial index `interview_sessions_user_created_idx`
 * (defined in `lib/db/schema/interviews.ts`).
 */
export async function listUserSessions(
  userId: string,
  options?: { limit?: number },
): Promise<SessionListItem[]> {
  const limit = Math.max(1, Math.min(100, options?.limit ?? 50));

  const rows = await db
    .select({
      id: schema.interviewSessions.id,
      companyName: schema.interviewSessions.companyName,
      roleTitle: schema.interviewSessions.roleTitle,
      level: schema.interviewSessions.level,
      roundType: schema.interviewSessions.roundType,
      state: schema.interviewSessions.state,
      scheduledAt: schema.interviewSessions.scheduledAt,
      createdAt: schema.interviewSessions.createdAt,
      outcomeType: schema.sessionOutcomes.outcomeType,
    })
    .from(schema.interviewSessions)
    .leftJoin(
      schema.sessionOutcomes,
      eq(schema.sessionOutcomes.sessionId, schema.interviewSessions.id),
    )
    .where(
      and(eq(schema.interviewSessions.userId, userId), SOFT_DELETE_FILTER),
    )
    .orderBy(desc(schema.interviewSessions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    outcomeType: (r.outcomeType ?? null) as OutcomeType | null,
  }));
}

/**
 * Fetch a single session if (and only if) it belongs to the given user.
 * Returns `null` for "not found" AND "owned by someone else" — the API
 * boundary deliberately doesn't disclose the difference.
 */
export async function getSession(
  sessionId: string,
  userId: string,
): Promise<InterviewSession | null> {
  const [row] = await db
    .select()
    .from(schema.interviewSessions)
    .where(
      and(
        eq(schema.interviewSessions.id, sessionId),
        eq(schema.interviewSessions.userId, userId),
        SOFT_DELETE_FILTER,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Read-only view of the current user, used by the dashboard header.
 */
export interface DashboardUser {
  id: string;
  name: string | null;
  email: string;
  imageUrl: string | null;
  /**
   * Auth.js writes a `Date` here when the email is verified (either by
   * the OAuth provider's `email_verified` claim or, eventually, by our
   * `/verify-email` flow). `null` = unverified. The `(app)` layout
   * uses this to gate access when email verification is enforced
   * (`features.email`).
   */
  emailVerified: Date | null;
  /**
   * When the user last accepted the Terms of Service. The (app)
   * layout compares this against `TERMS_VERSION_DATE` to drive
   * the re-acceptance modal.
   */
  termsAcceptedAt: Date | null;
}

/**
 * Wrapped in `react.cache(...)` so a single render that queries the
 * user from both the layout AND a page (e.g. dashboard) deduplicates
 * to ONE Postgres round-trip per request. The cache key is the
 * argument tuple, scoped to the request — there's no risk of leaking
 * one user's row to another's render.
 */
export const getDashboardUser = cache(
  async (userId: string): Promise<DashboardUser | null> => {
    // The `(app)` layout uses this lookup as its revocation gate. A
    // soft-deleted user must read back as `null` here so the layout's
    // `if (!user) redirect(...)` branch fires and they're bounced out.
    const [row] = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        imageUrl: schema.users.image,
        emailVerified: schema.users.emailVerified,
        termsAcceptedAt: schema.users.termsAcceptedAt,
      })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), ACTIVE_USER))
      .limit(1);
    return row ?? null;
  },
);
