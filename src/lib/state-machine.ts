import type { InterviewSessionState } from "@/lib/db/schema";

/**
 * Single source of truth for what counts as a legal lifecycle move on
 * an `interview_sessions` row. Every state mutation in the app
 * (server actions, API routes, background workers) MUST go through
 * `assertTransitionAllowed` before its UPDATE — that's how we enforce
 * the spec without having to scatter `if (state !== ...)` checks across
 * the codebase.
 *
 * The transitions are deliberately a superset of the user-visible
 * spec:
 *
 *   created   → recording, deleted
 *   recording → transcribing, deleted, failed
 *   transcribing → review, deleted, failed
 *   review    → analyzing, deleted
 *   analyzing → complete, deleted, failed
 *   complete  → analyzing (re-analysis), deleted
 *   failed    → review, complete, deleted     (operator/user reset)
 *
 * `failed` is allowed from the three states the worker pipeline can
 * realistically blow up in (recording / transcribing / analyzing). It
 * is NOT in the user-driven spec but is necessary so the worker can
 * write its own resilience state without tripping the guard.
 *
 * `failed` is also user-recoverable as of 2026-05-07: the report-page
 * Retry affordance flips a failed analysis back to its pre-analysis
 * state (`review` if there was no prior successful report, `complete`
 * if there was — i.e. a re-analysis that failed) and then fires the
 * analyze worker so the user re-runs analysis on the same transcript
 * without starting a brand new session. The state flip is gated by
 * the `/api/sessions/:id/reset` route, which additionally enforces
 * "only the failed-analysis path resets" (failed-recording / failed-
 * transcribing aren't safe to resurrect — the audio / transcript
 * pipeline state isn't recoverable from the row alone).
 *
 * `uploading` and `expired` exist in the DB enum for forward
 * compatibility but no transition wires them yet. The "all other
 * transitions return 409 CONFLICT" rule from the spec means leaving
 * them out is the safe default — adding them later is a code change,
 * adding them prematurely is a security bug.
 */

export type AppSessionState = Exclude<
  InterviewSessionState,
  "uploading" | "expired"
>;

/**
 * Adjacency map. Frozen so a stray runtime mutation can't widen the
 * graph and silently allow an illegal transition.
 */
export const ALLOWED_TRANSITIONS = {
  created: ["recording", "deleted"],
  recording: ["transcribing", "deleted", "failed"],
  transcribing: ["review", "deleted", "failed"],
  review: ["analyzing", "deleted"],
  analyzing: ["complete", "deleted", "failed"],
  complete: ["analyzing", "deleted"],
  // `deleted` stays terminal — resurrecting a soft-deleted session
  // would un-honour the user's deletion intent. Hard-delete via the
  // retention sweeper.
  deleted: [] as InterviewSessionState[],
  // `failed` is recoverable along the analysis path only. The reset
  // route picks `review` vs `complete` based on whether a prior
  // successful report exists. `deleted` is also allowed so a user
  // who decides to abandon a failed session can still soft-delete it.
  failed: ["review", "complete", "deleted"],
} as const satisfies Record<AppSessionState, readonly InterviewSessionState[]>;

/**
 * Discriminated result so callers can branch without try/catch noise.
 * The 409 string in `kind` lines up with the HTTP status the API route
 * returns when this fails, by design — a single source of truth for
 * the error contract.
 */
export type TransitionCheck =
  | { ok: true }
  | { ok: false; kind: "conflict"; from: string; to: string };

/**
 * Pure check (no side effects). Returns `ok: false` for:
 *   - a `from` state that isn't in the user-visible state machine
 *     (e.g. a row that's already in `uploading` or `expired`),
 *   - any `to` state not listed in `ALLOWED_TRANSITIONS[from]`,
 *   - identity transitions (`from === to`) — those are no-ops at best
 *     and a sign of a bug at worst, and the spec doesn't list them.
 *
 * The `from`/`to` values come back as plain strings so the API
 * response can include them in the error body without a separate
 * narrowing step.
 */
export function checkTransition(
  from: InterviewSessionState,
  to: InterviewSessionState,
): TransitionCheck {
  const allowed = (ALLOWED_TRANSITIONS as Record<string, readonly string[]>)[
    from
  ];
  if (!allowed || !allowed.includes(to)) {
    return { ok: false, kind: "conflict", from, to };
  }
  return { ok: true };
}

/**
 * Throwing variant for code paths that prefer try/catch — mostly the
 * API route boundary, where an exception unwinds cleanly to a 409
 * response.
 */
export class StateTransitionError extends Error {
  readonly status = 409;
  readonly code = "state_transition_not_allowed";
  constructor(
    readonly from: InterviewSessionState,
    readonly to: InterviewSessionState,
  ) {
    super(
      `Illegal session state transition: ${from} → ${to}. ` +
        `Allowed targets from ${from}: [${
          (ALLOWED_TRANSITIONS as Record<string, readonly string[]>)[from]?.join(
            ", ",
          ) ?? ""
        }].`,
    );
    this.name = "StateTransitionError";
  }
}

export function assertTransitionAllowed(
  from: InterviewSessionState,
  to: InterviewSessionState,
): void {
  const result = checkTransition(from, to);
  if (!result.ok) throw new StateTransitionError(from, to);
}
