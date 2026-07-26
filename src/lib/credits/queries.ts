import "server-only";

import { aliasedTable, and, count, desc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  CreditTransactionReason,
  CreditPackType,
} from "@/lib/db/schema";
import {
  REBUILD_CRITIQUE_CREDIT_COST,
  REBUILD_CRITIQUE_UNITS_PER_CREDIT,
} from "./pricing";

/**
 * Read-side helpers for the credits/billing surface.
 *
 * Lives separately from `consume.ts` (which holds the write-side
 * transaction helpers) so the SSR pages that just need to know
 * "has this session already consumed its free re-run?" can import
 * from a smaller, lighter module.
 */

/**
 * Returns `true` when the session has already had its one free
 * re-analysis consumed AND not subsequently rolled back.
 *
 * The signal is the NET count of `delta = 0` `interview_charge`
 * rows minus `delta = 0` `interview_refund` rows for the session:
 *
 *   - Each successful free re-analysis writes one delta=0
 *     `interview_charge` row (via `consumeCreditsForAnalysis`).
 *   - Each free-re-analysis ROLLBACK (dispatch failure handled
 *     by `refundConsumedCredits`, or worker failure handled by
 *     `recordAnalysisFailure`) writes one delta=0
 *     `interview_refund` row.
 *
 * The net > 0 case means "a free re-run was consumed AND has not
 * been refunded" — which is the only state where the user has
 * actually received the value of their free re-run. If a free
 * re-run was charged then immediately rolled back because the
 * worker couldn't run (LLM transient error before the model was
 * billed, etc.), the user gets their free slot
 * back; the spec says "one free re-run per session", not "one
 * attempt per session".
 *
 * Why one-shot per session, NOT per 24h window:
 *   - Each free re-run still triggers a real LLM call. We
 *     want to give candidates ONE clean re-run after they edit
 *     the transcript (the typical "I noticed a typo" flow); we do
 *     NOT want to subsidise unbounded LLM rolls in the 24h window.
 *   - The 24h window in `isFreeReanalysis` continues to gate the
 *     ELIGIBILITY for the free re-run (no free re-run if the
 *     report is older than 24h). Composing the two checks gives:
 *       free = isFreeReanalysis(...) && !hasConsumedFreeReanalysis(...)
 *     which is exactly the spec the candidate-facing button uses.
 *
 * Ownership-scoped: the `userId` filter is defense in depth
 * against a future caller that wires this helper into a route
 * without first verifying session ownership. The session-id alone
 * would still answer correctly for current call sites (which all
 * verify ownership upstream), but adding the user filter:
 *   1. Blocks a probe-attack timing-side-channel that could
 *      enumerate session existence across users.
 *   2. Mirrors the explicit-ownership pattern used by
 *      `consumeCreditsForAnalysis`, so reviewers don't have to
 *      cross-reference call sites to convince themselves of
 *      tenancy isolation.
 *
 * `sessionId` and `userId` MUST be validated UUIDs (the routes
 * use Zod for this). An invalid string would surface as a
 * Postgres parse error rather than silently returning false.
 */
export async function hasConsumedFreeReanalysis(args: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const baseFilter = and(
    eq(schema.creditTransactions.relatedSessionId, args.sessionId),
    eq(schema.creditTransactions.userId, args.userId),
    eq(schema.creditTransactions.delta, 0),
  );

  const [chargeRow, refundRow] = await Promise.all([
    db
      .select({ value: count() })
      .from(schema.creditTransactions)
      .where(
        and(baseFilter, eq(schema.creditTransactions.reason, "interview_charge")),
      ),
    db
      .select({ value: count() })
      .from(schema.creditTransactions)
      .where(
        and(baseFilter, eq(schema.creditTransactions.reason, "interview_refund")),
      ),
  ]);

  const charges = chargeRow[0]?.value ?? 0;
  const refunds = refundRow[0]?.value ?? 0;
  return charges - refunds > 0;
}

/**
 * One row of the user-facing credit history list. Joins
 * `credit_transactions` with the related session (so we can show
 * "Coding interview at Stripe") and the related purchase (so we can
 * show "Standard pack — $29.00") in a single round-trip.
 *
 * Both joins are LEFT JOINs because:
 *   - Most rows reference exactly one of the two (a charge has a
 *     session, a purchase has a purchase row).
 *   - `rebuild_critique_charge` rows reference NEITHER — the rebuild
 *     attribution lives on a sibling `audit_log` row, not on the
 *     ledger column. We render those as "Practice rebuild critique"
 *     with no link.
 *   - Hard-deleted sessions / purchases survive in the ledger with
 *     `related_*_id = NULL` (FK is `ON DELETE SET NULL`), so the
 *     ledger row keeps its financial truth even if the artifact is
 *     gone. The UI degrades gracefully to "Session (deleted)".
 */
export interface CreditHistoryItem {
  id: number;
  delta: number;
  balanceAfter: number;
  reason: CreditTransactionReason;
  createdAt: Date;
  relatedSession: {
    id: string;
    companyName: string;
    roleTitle: string;
  } | null;
  relatedPurchase: {
    id: string;
    packType: CreditPackType;
    creditsPurchased: number;
    /** Gross paid in paise (INR × 100). GST embedded. */
    amountPaidPaise: number;
  } | null;
  /**
   * Populated only on `referral_bonus` rows. Surfaces the referee
   * whose first-analysis completion triggered the +1 grant so the
   * history page can render "Referral from <name>". The label is
   * the referee's display name when set, otherwise their email.
   *
   * Hard-deleted referees null out the FK, so the row stays in
   * the ledger (financial truth) but loses attribution; the page
   * degrades to "Referral from a friend".
   */
  relatedReferee: {
    id: string;
    label: string;
  } | null;
}

/**
 * Read-side helper for the `/credits/history` page. Returns the
 * user's credit ledger newest-first with the related session /
 * purchase context already joined in.
 *
 * Ownership-scoped on `userId` — callers should still verify the
 * session is alive upstream, but the WHERE clause here is the
 * load-bearing tenancy guard.
 *
 * The default cap is 100 rows; the upper bound (500) is a defense
 * against a future caller asking for "all of it" on a power user
 * with thousands of ledger rows. The dashboard / history page never
 * needs more than a single page, so the limit doubles as a
 * pagination hint.
 */
export async function listCreditTransactions(args: {
  userId: string;
  limit?: number;
}): Promise<CreditHistoryItem[]> {
  const limit = Math.max(1, Math.min(500, args.limit ?? 100));

  // Aliased self-join on `users` so we can pull the REFEREE'S
  // display name + email for `referral_bonus` rows without
  // colliding with any other join into `users` upstream.
  const referee = aliasedTable(schema.users, "referee");

  const rows = await db
    .select({
      id: schema.creditTransactions.id,
      delta: schema.creditTransactions.delta,
      balanceAfter: schema.creditTransactions.balanceAfter,
      reason: schema.creditTransactions.reason,
      createdAt: schema.creditTransactions.createdAt,
      sessionId: schema.interviewSessions.id,
      sessionCompany: schema.interviewSessions.companyName,
      sessionRole: schema.interviewSessions.roleTitle,
      purchaseId: schema.creditPurchases.id,
      purchasePackType: schema.creditPurchases.packType,
      purchaseCredits: schema.creditPurchases.creditsPurchased,
      purchaseAmountPaise: schema.creditPurchases.amountPaidPaise,
      refereeId: referee.id,
      refereeName: referee.name,
      refereeEmail: referee.email,
    })
    .from(schema.creditTransactions)
    .leftJoin(
      schema.interviewSessions,
      eq(
        schema.creditTransactions.relatedSessionId,
        schema.interviewSessions.id,
      ),
    )
    .leftJoin(
      schema.creditPurchases,
      eq(
        schema.creditTransactions.relatedPurchaseId,
        schema.creditPurchases.id,
      ),
    )
    .leftJoin(
      referee,
      eq(schema.creditTransactions.relatedRefereeUserId, referee.id),
    )
    .where(eq(schema.creditTransactions.userId, args.userId))
    .orderBy(desc(schema.creditTransactions.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    createdAt: row.createdAt,
    relatedSession:
      row.sessionId !== null
        ? {
            id: row.sessionId,
            companyName: row.sessionCompany ?? "",
            roleTitle: row.sessionRole ?? "",
          }
        : null,
    relatedPurchase:
      row.purchaseId !== null
        ? {
            id: row.purchaseId,
            packType: row.purchasePackType as CreditPackType,
            creditsPurchased: row.purchaseCredits ?? 0,
            amountPaidPaise: row.purchaseAmountPaise ?? 0,
          }
        : null,
    relatedReferee:
      row.refereeId !== null
        ? {
            id: row.refereeId,
            label: row.refereeName ?? row.refereeEmail ?? "a friend",
          }
        : null,
  }));
}

/**
 * The four AI-call surfaces that share the rebuild-critique
 * sub-credit accumulator. Each call (whether or not it rolls over
 * to a whole-credit charge) writes a `${surface}.unit_charged`
 * audit_log row — that's the read source for the per-call 0.20
 * deduction history.
 *
 * Centralized as a tuple of literal strings so a future fifth
 * surface added to the discriminated union in
 * `rebuild-critique.ts` will need to be added here too — the
 * cross-file invariant is enforced by code review, not by the
 * compiler, but the literal-type repetition keeps the grep
 * surface small ("find all places that know about the unit
 * surfaces").
 */
const AI_UNIT_CHARGED_EVENT_TYPES = [
  "rebuild_critique.unit_charged",
  "rebuild_suggest.unit_charged",
  "story_suggest.unit_charged",
  "story_draft.unit_charged",
] as const;

export type AiUnitChargeSurface =
  | "rebuild_critique"
  | "rebuild_suggest"
  | "story_suggest"
  | "story_draft";

/**
 * One row of the user-facing AI-usage list. Synthesized from
 * `audit_log` `*.unit_charged` events — there's no `credit_transactions`
 * row for a non-rollover sub-credit deduction (the ledger is
 * integer-only) so the audit row is the financial truth for
 * per-call attribution.
 *
 * `creditCost` is read from `event_data.creditCost` (written at
 * charge time) rather than re-derived at read time so a future
 * change to `REBUILD_CRITIQUE_CREDIT_COST` doesn't retroactively
 * relabel old history entries.
 */
export interface AiUnitChargeItem {
  id: number;
  surface: AiUnitChargeSurface;
  /** 0.20 in v1, but written to the audit row so historical rows survive a future re-price. */
  creditCost: number;
  /** Whether this call also rolled over a whole credit from `credit_balance`. */
  rolledOver: boolean;
  /** Optional related rebuild id (for rebuild_critique / rebuild_suggest surfaces). */
  rebuildId: string | null;
  /** Optional related story id (for story_suggest surface). */
  storyId: string | null;
  createdAt: Date;
}

/**
 * Read-side helper for the `/credits/history` page: fetch the
 * per-call AI-usage rows from `audit_log`. Each row represents a
 * single 0.20-credit deduction (one "Generate AI draft" or
 * "Get critique" click) so the user can audit every paid AI call,
 * not just the rollup whole-credit rollovers.
 *
 * Newest-first; default cap matches `listCreditTransactions` so the
 * merged history page sees compatible page sizes.
 */
export async function listAiUnitCharges(args: {
  userId: string;
  limit?: number;
}): Promise<AiUnitChargeItem[]> {
  const limit = Math.max(1, Math.min(500, args.limit ?? 200));

  const rows = await db
    .select({
      id: schema.auditLog.id,
      eventType: schema.auditLog.eventType,
      eventData: schema.auditLog.eventData,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.userId, args.userId),
        inArray(
          schema.auditLog.eventType,
          AI_UNIT_CHARGED_EVENT_TYPES as unknown as string[],
        ),
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(limit);

  return rows.map((row) => {
    const data = (row.eventData ?? {}) as Record<string, unknown>;
    const surface = (row.eventType.replace(
      /\.unit_charged$/,
      "",
    ) as AiUnitChargeSurface);
    const rawCost = data.creditCost;
    const creditCost =
      typeof rawCost === "number" && Number.isFinite(rawCost)
        ? rawCost
        // Fallback for any pre-existing rows that pre-date the
        // `creditCost` field (none in production today, but the
        // helper is the source of truth so it stays robust).
        : REBUILD_CRITIQUE_CREDIT_COST;
    return {
      id: row.id,
      surface,
      creditCost,
      rolledOver:
        typeof data.rolledOver === "boolean" ? data.rolledOver : false,
      rebuildId:
        typeof data.rebuildId === "string" ? data.rebuildId : null,
      storyId: typeof data.storyId === "string" ? data.storyId : null,
      createdAt: row.createdAt,
    };
  });
}

// Re-exported here so callers can build a merged history view
// without re-importing from `pricing` separately.
export { REBUILD_CRITIQUE_UNITS_PER_CREDIT };
