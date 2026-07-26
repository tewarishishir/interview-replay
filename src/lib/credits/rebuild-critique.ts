import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

import { InsufficientCreditsError } from "./consume";
import {
  REBUILD_CRITIQUE_CREDIT_COST,
  REBUILD_CRITIQUE_UNITS_PER_CREDIT,
} from "./pricing";

/**
 * Sub-credit charging for Practice Rebuild critiques.
 *
 * The product price is 0.20 credits per critique. The credit ledger
 * (`credit_transactions.delta`) and the running balance
 * (`users.credit_balance`) are integer-only — rescaling the whole
 * credit system to "credit cents" for one feature would touch every
 * pricing/UI/test path, so instead we accumulate critiques in
 * `users.rebuild_critique_units` and deduct one whole credit on the
 * 5th critique (resetting the counter to 0).
 *
 * Invariants this module enforces (FOR UPDATE on the user row inside
 * a transaction so concurrent critique calls serialize cleanly):
 *
 *   1. The accumulator stays in `[0, REBUILD_CRITIQUE_UNITS_PER_CREDIT)`.
 *      A CHECK constraint on the column is the database-level backstop;
 *      this helper is the only path that should mutate the column.
 *   2. The whole-credit ledger row is written iff the accumulator
 *      rolls over. Critiques 1–3 (or N-1 in general) write nothing
 *      to the ledger and don't touch `credit_balance`.
 *   3. A rollover that would drive the balance negative throws
 *      `InsufficientCreditsError` BEFORE writing anything. The route
 *      handler maps this to a 402 (same shape as the analyze flow's
 *      out-of-credits path so the UI can reuse the same error copy
 *      and "Buy credits →" CTA).
 *
 * Failure semantics: this helper is called AFTER the LLM round-trip
 * has succeeded (and we got `passedGuardrails === true`). The cost
 * has already been incurred at the LLM provider; if the rollover charge
 * fails (race: balance dropped after the route's preflight check),
 * the route logs and serves the critique anyway — we don't have a
 * good way to "un-call" the model, and forcing the user to re-pay
 * for a critique they already saw is worse UX than swallowing the
 * occasional sub-cent loss.
 */

/**
 * Discriminated union of surfaces that can charge against the
 * rebuild critique accumulator. Drives the audit log row's
 * `event_type` and `event_data` shape so dispute resolution can
 * tell "this credit was charged for a rebuild critique" apart
 * from "this credit was charged for a bank-surface AI draft".
 *
 * All four surfaces share the SAME accumulator and the SAME
 * whole-credit deduction logic — the only thing that differs is
 * how the audit row is labelled.
 *
 *   - `rebuild_critique`  : POST /api/rebuilds/:id/critique
 *   - `rebuild_suggest`   : POST /api/rebuilds/:id/suggest-response
 *   - `story_suggest`     : POST /api/stories/:id/suggest-response
 *   - `story_draft`       : POST /api/stories/draft-suggestion (form-time;
 *                           no entity id because no story has been saved yet)
 *   - `story_critique`    : POST /api/stories/critique (stateless story-bank
 *                           critique; no entity id because the critique is not
 *                           persisted — the user can run it before saving)
 *   - `story_enhance`     : POST /api/stories/enhance (stateless story-bank
 *                           enhance; no entity id; shares the per-user 10/24h
 *                           story AI budget with story_critique)
 */
export type ChargeRebuildSurface =
  | { kind: "rebuild_critique"; rebuildId: string }
  | { kind: "rebuild_suggest"; rebuildId: string }
  | { kind: "story_suggest"; storyId: string }
  | { kind: "story_draft" }
  | { kind: "story_critique" }
  | { kind: "story_enhance" };

export interface ChargeRebuildCritiqueArgs {
  userId: string;
  /**
   * Legacy parameter: when provided without an explicit
   * `surface`, it's treated as the rebuild critique surface.
   * Kept for back-compat with the original critique route. New
   * callers should pass `surface` directly.
   *
   * Mutually optional with `surface` — at least one of the two
   * must be set.
   */
  rebuildId?: string;
  /**
   * Surface that triggered this charge. When provided, takes
   * precedence over `rebuildId`. Drives the audit row's
   * `event_type` and `event_data` shape so dispute resolution
   * surfaces the right entity id.
   */
  surface?: ChargeRebuildSurface;
}

export interface ChargeRebuildCritiqueResult {
  /**
   * Whole credits actually deducted from `credit_balance` on this
   * call. Either 0 (counter incremented but didn't roll over) or 1
   * (counter rolled over and one credit was charged). No other value
   * is possible by construction.
   */
  creditsCharged: 0 | 1;
  /**
   * `credit_balance` after this call. Equal to the prior balance when
   * `creditsCharged === 0`, or `prior - 1` when `creditsCharged === 1`.
   */
  balanceAfter: number;
  /**
   * `rebuild_critique_units` after this call, in
   * `[0, REBUILD_CRITIQUE_UNITS_PER_CREDIT)`.
   */
  unitsAfter: number;
  /** True when the accumulator rolled over and a credit was charged. */
  rolledOver: boolean;
}

/**
 * Atomically advance the rebuild-critique accumulator and (when it
 * rolls over) deduct one whole credit + write a ledger row + a
 * rollover audit row.
 *
 * Throws `InsufficientCreditsError` ONLY on the rollover-without-
 * balance case — critiques that don't roll over never read the
 * balance and never refuse the call.
 */
export async function chargeRebuildCritique(
  args: ChargeRebuildCritiqueArgs,
): Promise<ChargeRebuildCritiqueResult> {
  // Cheap input validation. These should never trip in practice
  // (the route validates both via Zod / session lookup before
  // calling) but a typo at a future call site would otherwise
  // surface as a confusing Postgres error mid-transaction.
  if (typeof args.userId !== "string" || args.userId.length === 0) {
    throw new TypeError("chargeRebuildCritique: userId is required");
  }
  // Resolve the surface. Either an explicit `surface` arg or a
  // legacy `rebuildId` (which we wrap into the `rebuild_critique`
  // shape so the audit log preserves the historical eventType).
  const surface: ChargeRebuildSurface =
    args.surface ??
    (typeof args.rebuildId === "string" && args.rebuildId.length > 0
      ? { kind: "rebuild_critique", rebuildId: args.rebuildId }
      : (() => {
          throw new TypeError(
            "chargeRebuildCritique: either `surface` or `rebuildId` is required",
          );
        })());

  return db.transaction(async (tx) => {
    // Lock the user row so concurrent rebuild-critique charges (and
    // any other consume-flow lock on the same user) serialize. We
    // re-read both `credit_balance` and `rebuild_critique_units`
    // under the lock so the rollover decision is made on the same
    // snapshot we update from.
    const lockedRows = await tx.execute<{
      id: string;
      credit_balance: number;
      rebuild_critique_units: number;
    }>(sql`
      SELECT id, credit_balance, rebuild_critique_units
      FROM ${schema.users}
      WHERE id = ${args.userId} AND deleted_at IS NULL
      FOR UPDATE
    `);

    const userRow = lockedRows.rows[0];
    if (!userRow) {
      // The user row doesn't exist (or is soft-deleted). The route
      // handler ran an active-user check upstream so this should be
      // unreachable; treat it as a 0-credit "we did nothing" so the
      // route can decide whether to throw or shrug.
      throw new Error(
        `chargeRebuildCritique: user ${args.userId} not found or soft-deleted`,
      );
    }

    const currentUnits = userRow.rebuild_critique_units;
    const currentBalance = userRow.credit_balance;

    // Defense-in-depth sanity check. The CHECK constraint
    // `users_rebuild_critique_units_range` should keep the column
    // in `[0, REBUILD_CRITIQUE_UNITS_PER_CREDIT)` at all times; an
    // out-of-range value here means the constraint was dropped, the
    // schema drifted from the constant, or someone wrote the column
    // outside this helper. Refuse the charge — silently rolling over
    // would mask the corruption AND potentially over-charge the user.
    if (
      !Number.isInteger(currentUnits) ||
      currentUnits < 0 ||
      currentUnits >= REBUILD_CRITIQUE_UNITS_PER_CREDIT
    ) {
      throw new Error(
        `chargeRebuildCritique: user ${args.userId} has an out-of-range ` +
          `rebuild_critique_units value (${currentUnits}); refusing to ` +
          `charge until the row is reconciled.`,
      );
    }

    const willRollOver =
      currentUnits + 1 >= REBUILD_CRITIQUE_UNITS_PER_CREDIT;

    // Per-surface event_data shape used for BOTH the per-call
    // `*.unit_charged` audit row (every call) and the rollover
    // `*.credit_charged` audit row (only on the Nth call). Each
    // surface contributes exactly the fields it owns (rebuildId
    // vs storyId vs nothing for the form-time draft) — the audit
    // row's keys stay clean for the SQL pattern
    // `event_data->>'storyId'` etc.
    const surfaceData: { rebuildId?: string; storyId?: string } = (() => {
      switch (surface.kind) {
        case "rebuild_critique":
        case "rebuild_suggest":
          return { rebuildId: surface.rebuildId };
        case "story_suggest":
          return { storyId: surface.storyId };
        case "story_draft":
          // Form-time draft: no entity id (the story hasn't been
          // saved yet). The audit row is still useful for "I
          // generated drafts at 4:30pm and 4:31pm" timeline
          // reconstruction.
          return {};
        case "story_critique":
          // Stateless story-bank critique: no entity id (the draft
          // is not persisted). Audit row's event_type drives the
          // per-user 10/24h story AI rate gate.
          return {};
        case "story_enhance":
          // Stateless story-bank enhance: no entity id. Audit row's
          // event_type is counted alongside story_critique events in
          // the per-user 10/24h story AI budget gate.
          return {};
        default: {
          // Exhaustiveness guard: a future surface added to the
          // discriminated union without a branch here would
          // silently write an empty event_data; the never-cast
          // forces a compile error instead.
          const _exhaustive: never = surface;
          throw new Error(
            `chargeRebuildCritique: unhandled surface kind: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    })();

    if (!willRollOver) {
      // Common path: critiques 1..(N-1) just bump the counter.
      // We do NOT write to `credit_transactions` (the ledger is
      // integer-only and a delta=0 row per call would balloon it
      // 5x), but we DO write a `*.unit_charged` audit row so the
      // user-facing credits history can show every 0.20-credit
      // deduction with full per-call attribution — the visibility
      // the integer ledger can't provide on its own.
      const unitsAfter = currentUnits + 1;
      await tx
        .update(schema.users)
        .set({
          rebuildCritiqueUnits: unitsAfter,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, args.userId));

      const unitChargedEventType = `${surface.kind}.unit_charged` as const;
      await tx.insert(schema.auditLog).values({
        userId: args.userId,
        eventType: unitChargedEventType,
        eventData: {
          ...surfaceData,
          creditCost: REBUILD_CRITIQUE_CREDIT_COST,
          unitsBeforeCharge: currentUnits,
          unitsAfterCharge: unitsAfter,
          balanceBefore: currentBalance,
          balanceAfter: currentBalance,
          unitsPerCredit: REBUILD_CRITIQUE_UNITS_PER_CREDIT,
          rolledOver: false,
        },
      });

      return {
        creditsCharged: 0,
        balanceAfter: currentBalance,
        unitsAfter,
        rolledOver: false,
      };
    }

    // Rollover path. Refuse if the user can't afford the whole-credit
    // charge. The route's preflight check (`previewRebuildCritiqueCost`)
    // is supposed to catch this BEFORE the LLM call so we don't waste
    // an LLM round-trip on an out-of-credits user; landing here
    // means a race between preflight and now (e.g. a concurrent
    // analyze flow drained the balance during the LLM call).
    if (currentBalance < 1) {
      throw new InsufficientCreditsError(1, currentBalance);
    }

    const balanceAfter = currentBalance - 1;
    await tx
      .update(schema.users)
      .set({
        creditBalance: balanceAfter,
        rebuildCritiqueUnits: 0,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, args.userId));

    const [ledgerRow] = await tx
      .insert(schema.creditTransactions)
      .values({
        userId: args.userId,
        delta: -1,
        balanceAfter,
        reason: "rebuild_critique_charge",
        // No `relatedSessionId` — the ledger column references
        // `interview_sessions`, not `story_rebuilds`. The rebuild
        // attribution lives on the audit_log entry below (which has
        // a JSONB `event_data` column we can put the rebuildId in).
      })
      .returning({ id: schema.creditTransactions.id });
    if (!ledgerRow) {
      throw new Error(
        "chargeRebuildCritique: ledger INSERT returned no row",
      );
    }

    // Audit row attributing the rollover to a specific surface.
    // This is the dispute-resolution surface: when a user asks
    // "why did I lose 1 credit at 4:30pm?" we look up `audit_log`
    // rows with the matching `event_type` and timestamp, and
    // read the entity id from `event_data`. The
    // `credit_transactions` row is the financial record; this is
    // the application-domain "why" record.
    //
    // Per-surface event types so a support engineer can grep for
    // `rebuild_critique.credit_charged` without false positives
    // from the (different shape) story-side surfaces.
    const eventType = `${surface.kind}.credit_charged` as const;
    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType,
      eventData: {
        ...surfaceData,
        ledgerRowId: ledgerRow.id,
        unitsBeforeCharge: currentUnits,
        unitsAfterCharge: 0,
        balanceBefore: currentBalance,
        balanceAfter,
        unitsPerCredit: REBUILD_CRITIQUE_UNITS_PER_CREDIT,
      },
    });

    // Per-call `*.unit_charged` audit row for the rollover call.
    // Mirrors the non-rollover branch: every paid AI call gets a
    // unit_charged row so the user-facing credits history shows
    // a 0.20-credit deduction for EVERY call. The rollover-specific
    // `*.credit_charged` row above is the whole-credit accounting
    // event; this row is the per-call user-visible event. We write
    // both because they answer different questions:
    //   - `*.unit_charged` (per call) → "where did my 0.20 credits go?"
    //   - `*.credit_charged` (rollover) → "where did my whole credit go?"
    const unitChargedEventType = `${surface.kind}.unit_charged` as const;
    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: unitChargedEventType,
      eventData: {
        ...surfaceData,
        creditCost: REBUILD_CRITIQUE_CREDIT_COST,
        unitsBeforeCharge: currentUnits,
        unitsAfterCharge: 0,
        balanceBefore: currentBalance,
        balanceAfter,
        unitsPerCredit: REBUILD_CRITIQUE_UNITS_PER_CREDIT,
        rolledOver: true,
        ledgerRowId: ledgerRow.id,
      },
    });

    return {
      creditsCharged: 1,
      balanceAfter,
      unitsAfter: 0,
      rolledOver: true,
    };
  });
}

export interface PreviewRebuildCritiqueCostArgs {
  userId: string;
}

export interface PreviewRebuildCritiqueCostResult {
  /** Whole credits the next critique would charge: 0 or 1. */
  wouldChargeCredits: 0 | 1;
  /** Current `credit_balance`. */
  currentBalance: number;
  /** Current `rebuild_critique_units`. */
  currentUnits: number;
  /**
   * False iff `wouldChargeCredits === 1` AND `currentBalance < 1`.
   * The route handler short-circuits to 402 when this is false so we
   * don't burn an LLM call on an out-of-credits user.
   */
  canAffordNext: boolean;
}

/**
 * Read-only preview of what the user's next rebuild critique would
 * cost and whether they can afford it. Called from the critique
 * route BEFORE the LLM round-trip — running it post-LLM defeats the
 * point (we'd already have paid for the LLM call on an unaffordable call).
 *
 * Race-safe enough for a preflight: a concurrent rebuild critique or
 * analyze call can drain the balance between this read and the
 * `chargeRebuildCritique` write. The transactional FOR UPDATE inside
 * `chargeRebuildCritique` is the authoritative gate; this helper is
 * the cheap "don't-pay-for-the-LLM-if-clearly-broke" optimization.
 *
 * Soft-delete filter mirrors `chargeRebuildCritique` so a JWT that
 * outlives a soft-deletion can't slip past the preflight by reading
 * a stale balance — both surfaces refuse the same set of users.
 * Returns `null` for "user not found / soft-deleted" so the caller
 * can map to 401 / refresh instead of bubbling a 500.
 */
export async function previewRebuildCritiqueCost(
  args: PreviewRebuildCritiqueCostArgs,
): Promise<PreviewRebuildCritiqueCostResult | null> {
  if (typeof args.userId !== "string" || args.userId.length === 0) {
    throw new TypeError("previewRebuildCritiqueCost: userId is required");
  }

  const [user] = await db
    .select({
      creditBalance: schema.users.creditBalance,
      rebuildCritiqueUnits: schema.users.rebuildCritiqueUnits,
    })
    .from(schema.users)
    .where(
      and(eq(schema.users.id, args.userId), isNull(schema.users.deletedAt)),
    )
    .limit(1);

  if (!user) return null;

  // Mirror the defense-in-depth check in `chargeRebuildCritique`:
  // an out-of-range value here means the column drifted from the
  // CHECK constraint or the constant. Refuse to claim "can afford"
  // until reconciliation — the charge would refuse anyway, so
  // returning the optimistic answer would just waste an LLM call.
  if (
    !Number.isInteger(user.rebuildCritiqueUnits) ||
    user.rebuildCritiqueUnits < 0 ||
    user.rebuildCritiqueUnits >= REBUILD_CRITIQUE_UNITS_PER_CREDIT
  ) {
    throw new Error(
      `previewRebuildCritiqueCost: user ${args.userId} has an out-of-range ` +
        `rebuild_critique_units value (${user.rebuildCritiqueUnits}); ` +
        `refusing to preflight until the row is reconciled.`,
    );
  }

  const willRollOver =
    user.rebuildCritiqueUnits + 1 >= REBUILD_CRITIQUE_UNITS_PER_CREDIT;
  const wouldChargeCredits: 0 | 1 = willRollOver ? 1 : 0;
  const canAffordNext = !willRollOver || user.creditBalance >= 1;

  return {
    wouldChargeCredits,
    currentBalance: user.creditBalance,
    currentUnits: user.rebuildCritiqueUnits,
    canAffordNext,
  };
}
