/**
 * Pure pricing helpers — no DB, no Stripe. Lives outside `server-only`
 * so the recorder UI and the submit-preview client island can run
 * the same calculation in the browser without a roundtrip.
 *
 * The spec maps recording duration to credits in 30-minute buckets:
 *
 *     ≤ 30 min  → 1 credit
 *     ≤ 60 min  → 2 credits
 *     ≤ 90 min  → 3 credits
 *     ≤ 120 min → 4 credits
 *     >  120 min → error
 *
 * 0 minutes is also rejected — a session that has no audio is a
 * pipeline bug, not a billable artifact.
 */

export const MAX_BILLABLE_SECONDS = 120 * 60;
export const SECONDS_PER_BUCKET = 30 * 60;
export const RE_ANALYSIS_FREE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Flat credit price for a paid re-analysis (i.e. re-running an
 * analysis on a session that already has at least one report
 * AND has either burned its single free re-run or is outside the
 * 24h free window).
 *
 * The product call here is: candidates get ONE free re-run per
 * session inside the 24h window after analysis, and after that
 * each additional re-run costs a flat 1 credit — NOT the
 * duration-based price they originally paid for the first
 * analysis. Re-running on the same audio is cheaper for us
 * (transcription cost is already sunk; only the LLM gets re-billed)
 * AND cheaper for the candidate (a single-credit throttle that
 * stops "spam re-analyze after every typo edit" without forcing
 * them to re-buy the full session price).
 *
 * Centralized here so the analyze API route and the /edit +
 * /submit page renders all agree on the price tag.
 */
export const REANALYSIS_FIXED_CREDIT_COST = 1;

/**
 * One Practice Rebuild critique (and one Story-Bank AI draft) costs
 * 0.20 credits — but the credit ledger and `users.credit_balance` are
 * integer columns and we don't want to rescale the entire credit
 * system for one feature. Instead, we accumulate sub-credit units in
 * `users.rebuild_critique_units` and deduct one whole credit on every
 * Nth call. This constant pins N (and therefore the 1/N display cost
 * — `1/5 = 0.20`).
 *
 * Changing this requires a coordinated migration: the column has a
 * CHECK constraint that bounds it to `[0, REBUILD_CRITIQUE_UNITS_PER_CREDIT)`,
 * and the marketing copy that says "0.20 credits per critique"
 * derives from `1 / N`. Migration `0021_rebuild_critique_units_per_credit_5.sql`
 * widened the bound from `< 4` to `< 5` for this change — MUST run
 * BEFORE the new constant deploys.
 */
export const REBUILD_CRITIQUE_UNITS_PER_CREDIT = 5;

/**
 * User-facing per-critique cost, derived from
 * `REBUILD_CRITIQUE_UNITS_PER_CREDIT`. The two are kept in sync by
 * computation (not by a second constant) so a future tweak to N
 * automatically updates the display copy.
 */
export const REBUILD_CRITIQUE_CREDIT_COST =
  1 / REBUILD_CRITIQUE_UNITS_PER_CREDIT;

/**
 * Compute the user's *effective* credit balance — the integer
 * `credit_balance` minus the sub-credit value currently held in the
 * `rebuild_critique_units` accumulator. Returns a fractional number.
 *
 * The integer balance alone over-reports what the user can spend in
 * future AI calls, because each call still in the accumulator has
 * already been incurred (the LLM round-trip already happened) but
 * is invisible to the integer column until the 5th call rolls over.
 *
 * Example: balance=10, units=3 → effective = 10 - 0.60 = 9.40 credits.
 *
 * Centralized here so the header pill, the credits-history page,
 * and any other "remaining balance" surface all compute the same
 * number from the same two inputs. Pure (no DB / no `server-only`)
 * so it can run in the browser if a client island ever needs to
 * mirror the value live.
 *
 * Tolerates `null/undefined` units (defaults to 0) so a query that
 * forgets to select the column doesn't crash — it just over-reports
 * the same way the legacy integer-only display did, which is the
 * safer regression.
 */
export function effectiveCreditBalance(
  creditBalance: number,
  rebuildCritiqueUnits: number | null | undefined,
): number {
  const units =
    typeof rebuildCritiqueUnits === "number" &&
    Number.isFinite(rebuildCritiqueUnits)
      ? rebuildCritiqueUnits
      : 0;
  return creditBalance - units / REBUILD_CRITIQUE_UNITS_PER_CREDIT;
}

/**
 * Format a (possibly fractional) credit value for display. Always
 * renders two decimal places ("2.00", "9.40", "0.20") so balances
 * line up vertically in the header pill and the history table.
 *
 * Centralized so a future tweak to the display format (e.g. "trim
 * trailing zeros when balance is whole") is a one-place change.
 */
export function formatCreditsDecimal(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

/**
 * Flat credit fee charged when a user soft-deletes a session that has
 * already been transcribed but not yet analyzed. We pay the transcription service per
 * minute of audio when the worker writes the transcript, so a delete
 * from `review` would otherwise leave us holding the bag for the STT
 * cost while the candidate walks away with the transcript value.
 *
 * Kept as a flat fee (rather than `creditsForDuration / 2` or similar)
 * because:
 *   1. Transcription-only is a strict subset of the full pipeline; a
 *      flat fee under-charges long sessions and slightly over-charges
 *      short ones, which biases toward "delete is cheap" — the right
 *      side of the UX trade-off here.
 *   2. One number is far easier to surface in the confirmation copy
 *      ("1 credit will be charged") than a duration-dependent quote
 *      that may contradict what the user remembers from the recorder.
 *
 * If we ever revisit, change this constant — the UI imports from this
 * module so the warning copy will follow automatically.
 */
export const TRANSCRIPTION_FEE_CREDITS = 1;

/**
 * Minimum recording length (seconds) before a delete actually triggers
 * the transcription fee. Below this threshold we treat the recording
 * as a "test" or "accidental" capture — the candidate is exploring
 * the recorder, hit start by mistake, or aborted within seconds — and
 * absorb the (small) transcription cost rather than punish that flow.
 *
 * 15 minutes is the product call: most real interviews run well past
 * 15 min, and most "I clicked the wrong button" recordings end well
 * short of it. Tune by changing this constant — the UI imports it so
 * the warning copy will only render when a charge will actually fire.
 */
export const MIN_DURATION_FOR_TRANSCRIPTION_FEE_SECONDS = 15 * 60;

/**
 * Returns the transcription fee that should be charged when soft-
 * deleting a session in the given state with the given recording
 * length. Centralized here so the server (DELETE handler) and the
 * client (DeleteSessionButton warning copy) agree on when a charge
 * applies AND on the duration threshold.
 *
 * Charge ladder:
 *   state === 'review' AND duration > MIN  → TRANSCRIPTION_FEE_CREDITS
 *   state === 'review' AND duration <= MIN → 0  (test / accidental
 *                                                recording — absorb
 *                                                the small STT cost)
 *   created / recording                    → 0  (no transcription
 *                                                happened)
 *   transcribing                           → 0  (in-flight; if
 *                                                the transcription service succeeds
 *                                                the row will move to
 *                                                `review` and a
 *                                                subsequent delete
 *                                                will pick up the
 *                                                charge)
 *   analyzing / complete                   → 0  (already paid the
 *                                                full pipeline price
 *                                                via the analyze
 *                                                consume — STT cost
 *                                                is included)
 *   anything else                          → 0  (terminal/unsupported
 *                                                states; the state-
 *                                                machine guard rejects
 *                                                the delete itself)
 *
 * `durationSeconds` is `null | undefined` tolerant — a missing
 * transcript row, or a row written with a 0/missing duration, both
 * read as "we don't have a billable recording", which is the safe
 * default (no charge).
 *
 * `state: string` rather than the enum so the helper is reachable
 * from client bundles without importing the server-only DB schema.
 * Callers feed it the state they already have on hand.
 */
export function transcriptionFeeForDelete(
  state: string,
  durationSeconds: number | null | undefined,
): number {
  if (state !== "review") return 0;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= MIN_DURATION_FOR_TRANSCRIPTION_FEE_SECONDS
  ) {
    return 0;
  }
  return TRANSCRIPTION_FEE_CREDITS;
}

export class DurationOutOfRangeError extends Error {
  readonly code = "duration_out_of_range";
  readonly status = 422;
  constructor(readonly durationSeconds: number) {
    super(
      `Recording is ${durationSeconds}s — analysis caps at ${MAX_BILLABLE_SECONDS}s (120 min). ` +
        "Trim the recording or split it into two sessions.",
    );
    this.name = "DurationOutOfRangeError";
  }
}

export function creditsForDuration(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new DurationOutOfRangeError(durationSeconds);
  }
  if (durationSeconds > MAX_BILLABLE_SECONDS) {
    throw new DurationOutOfRangeError(durationSeconds);
  }
  return Math.ceil(durationSeconds / SECONDS_PER_BUCKET);
}

/**
 * Re-analysis pricing per spec: if the user re-runs analysis on a
 * session within 24 hours of the most recent report, the session
 * is in the FREE-ELIGIBLE window. This is necessary but not
 * sufficient — `freeReanalysisAvailable` below also checks that
 * the session hasn't already burned its one free re-run.
 *
 * `lastReportAt === null` means there's no prior report — first
 * analysis, full price.
 */
export function isFreeReanalysis(args: {
  lastReportAt: Date | null;
  now?: Date;
}): boolean {
  if (!args.lastReportAt) return false;
  const now = args.now ?? new Date();
  return now.getTime() - args.lastReportAt.getTime() < RE_ANALYSIS_FREE_WINDOW_MS;
}

/**
 * Returns `true` when the candidate is eligible for a free re-run
 * RIGHT NOW for the given session.
 *
 * Two gates compose:
 *   1. The 24-hour window since the last analysis — `isFreeReanalysis`.
 *   2. One free re-run per session, ever — `freeReanalysisAlreadyUsed`,
 *      derived from the ledger by the server-only
 *      `hasConsumedFreeReanalysis` helper in `queries.ts`.
 *
 * The second gate exists because a free re-run still costs us a real
 * LLM call. Without it, the 24h window was an unbounded LLM-roll
 * factory: the candidate could click "Re-analyze (free re-run)"
 * repeatedly and burn LLM spend with zero credit revenue. The product
 * call is "give candidates one clean re-run after a transcript edit;
 * after that, paid only" — the credit cost is the throttle for everything
 * past the first free re-run.
 *
 * Pure function so it can be reached from both server (route, SSR
 * page) and any future client island that wants to mirror the
 * decision. Callers feed in the boolean from `hasConsumedFreeReanalysis`.
 */
export function freeReanalysisAvailable(args: {
  lastReportAt: Date | null;
  freeReanalysisAlreadyUsed: boolean;
  now?: Date;
}): boolean {
  if (args.freeReanalysisAlreadyUsed) return false;
  return isFreeReanalysis({ lastReportAt: args.lastReportAt, now: args.now });
}
