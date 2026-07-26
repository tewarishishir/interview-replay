/**
 * Pure unit tests for the lifecycle state machine. No DB, no
 * fixtures — every input/output is enumerated directly off the
 * spec, so a regression in `lib/state-machine.ts` shows up here
 * before it shows up as a 409 on a real session.
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  StateTransitionError,
  assertTransitionAllowed,
  checkTransition,
} from "@/lib/state-machine";
import type { InterviewSessionState } from "@/lib/db/schema";

const ALL_STATES: InterviewSessionState[] = [
  "created",
  "recording",
  "uploading",
  "transcribing",
  "review",
  "analyzing",
  "complete",
  "deleted",
  "failed",
  "expired",
];

const SPEC_TRANSITIONS: Array<{
  from: InterviewSessionState;
  to: InterviewSessionState;
}> = [
  { from: "created", to: "recording" },
  { from: "created", to: "deleted" },
  { from: "recording", to: "transcribing" },
  { from: "recording", to: "deleted" },
  { from: "transcribing", to: "review" },
  { from: "transcribing", to: "deleted" },
  { from: "review", to: "analyzing" },
  { from: "review", to: "deleted" },
  { from: "analyzing", to: "complete" },
  { from: "analyzing", to: "deleted" },
  { from: "complete", to: "analyzing" },
  { from: "complete", to: "deleted" },
  // failed is recoverable via the user-facing Retry affordance on
  // the report page (PR 2026-05-07). The reset route picks `review`
  // (no prior report) vs `complete` (re-analysis that failed) based
  // on `reports` table contents.
  { from: "failed", to: "review" },
  { from: "failed", to: "complete" },
  { from: "failed", to: "deleted" },
];

describe("state machine — spec-listed transitions", () => {
  for (const { from, to } of SPEC_TRANSITIONS) {
    it(`${from} → ${to} is allowed`, () => {
      expect(checkTransition(from, to)).toEqual({ ok: true });
      expect(() => assertTransitionAllowed(from, to)).not.toThrow();
    });
  }
});

describe("state machine — illegal transitions return conflict", () => {
  it("created → complete is rejected", () => {
    const result = checkTransition("created", "complete");
    expect(result).toEqual({
      ok: false,
      kind: "conflict",
      from: "created",
      to: "complete",
    });
  });

  it("recording → review (skipping transcribing) is rejected", () => {
    expect(checkTransition("recording", "review")).toMatchObject({
      ok: false,
      kind: "conflict",
    });
  });

  it("complete → recording (resurrect) is rejected", () => {
    expect(checkTransition("complete", "recording")).toMatchObject({
      ok: false,
      kind: "conflict",
    });
  });

  it("deleted → anything is rejected", () => {
    for (const to of ALL_STATES) {
      expect(checkTransition("deleted", to)).toMatchObject({ ok: false });
    }
  });

  it("identity transitions (X → X) are rejected", () => {
    // Every "happy" source state should reject self-transitions; they
    // signal a duplicate-write bug somewhere in the worker pipeline.
    for (const s of [
      "created",
      "recording",
      "transcribing",
      "review",
      "analyzing",
      "complete",
    ] as const) {
      expect(checkTransition(s, s)).toMatchObject({ ok: false });
    }
  });

  it("source states outside the user-visible machine are rejected", () => {
    // `uploading` and `expired` are infra-only states; nothing should
    // try to transition out of them through this checker.
    expect(checkTransition("uploading", "transcribing")).toMatchObject({
      ok: false,
    });
    expect(checkTransition("expired", "deleted")).toMatchObject({ ok: false });
  });
});

describe("state machine — error surface", () => {
  it("assertTransitionAllowed throws StateTransitionError with status 409", () => {
    try {
      assertTransitionAllowed("created", "complete");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StateTransitionError);
      const e = err as StateTransitionError;
      expect(e.status).toBe(409);
      expect(e.code).toBe("state_transition_not_allowed");
      expect(e.from).toBe("created");
      expect(e.to).toBe("complete");
      expect(e.message).toMatch(/Illegal session state transition/);
    }
  });

  it("ALLOWED_TRANSITIONS exposes the spec graph verbatim", () => {
    // Direct sanity check against the spec text. If a future edit
    // accidentally widens the graph (e.g. allows "review → complete"),
    // this assertion fires.
    expect(ALLOWED_TRANSITIONS.created).toEqual(["recording", "deleted"]);
    expect(ALLOWED_TRANSITIONS.recording).toEqual([
      "transcribing",
      "deleted",
      "failed",
    ]);
    expect(ALLOWED_TRANSITIONS.transcribing).toEqual([
      "review",
      "deleted",
      "failed",
    ]);
    expect(ALLOWED_TRANSITIONS.review).toEqual(["analyzing", "deleted"]);
    expect(ALLOWED_TRANSITIONS.analyzing).toEqual([
      "complete",
      "deleted",
      "failed",
    ]);
    expect(ALLOWED_TRANSITIONS.complete).toEqual(["analyzing", "deleted"]);
    expect(ALLOWED_TRANSITIONS.deleted).toEqual([]);
    expect(ALLOWED_TRANSITIONS.failed).toEqual([
      "review",
      "complete",
      "deleted",
    ]);
  });
});

describe("state machine — enum exhaustiveness", () => {
  /**
   * `AppSessionState` is a subset of `InterviewSessionState`. The
   * `satisfies Record<AppSessionState, ...>` clause on
   * `ALLOWED_TRANSITIONS` only enforces keys for the subset, so
   * adding a new value to the Postgres enum without thinking about
   * the state machine would compile silently and quietly 409 at
   * runtime. This test is the runtime safety net.
   *
   * Every enum value MUST be either:
   *   - A key in `ALLOWED_TRANSITIONS` (user-visible state, even if
   *     terminal — `deleted`/`failed` have an explicit empty array),
   *     OR
   *   - Listed in `INFRA_ONLY_STATES` below (worker-pipeline state
   *     that's never reached via a user click).
   *
   * If a future migration adds a new enum value, this test fails
   * loudly until either the graph is extended or the value is
   * explicitly opted into the infra-only set.
   */
  const INFRA_ONLY_STATES: ReadonlyArray<InterviewSessionState> = [
    "uploading",
    "expired",
  ];

  it("every InterviewSessionState is either user-visible or explicitly infra-only", () => {
    for (const state of ALL_STATES) {
      const inMachine = state in ALLOWED_TRANSITIONS;
      const inInfra = INFRA_ONLY_STATES.includes(state);
      expect(
        inMachine !== inInfra,
        `'${state}' must appear in either ALLOWED_TRANSITIONS or INFRA_ONLY_STATES, not both and not neither.`,
      ).toBe(true);
    }
  });

  it("infra-only states have no user-driven outbound edges", () => {
    // A worker writing `state = 'uploading'` should never be
    // reachable via the user-facing state machine; trying to
    // transition out of it via `checkTransition` must fail.
    for (const state of INFRA_ONLY_STATES) {
      for (const target of ALL_STATES) {
        expect(checkTransition(state, target)).toMatchObject({ ok: false });
      }
    }
  });
});
