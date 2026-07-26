import type { InterviewLevel, InterviewRoundType } from "@/lib/db/schema";

import { codingRubric } from "./coding";
import { systemDesignRubric } from "./system_design";
import { behavioralRubric } from "./behavioral";
import { otherRubric } from "./other";

export type Level = InterviewLevel;

/**
 * Stable identifier for the rubric *content version*. Bump this any
 * time the rubric body changes so historic reports can be re-rendered
 * with the rubric they were generated against (the value is stamped
 * onto `reports.rubric_version` at insert).
 */
export const RUBRIC_VERSION = "2026-05-06.v1" as const;

/**
 * Resolve the rubric text for a (round_type, level) pair. The
 * round-type-specific rubric file exports a `(level: Level) => string`
 * so the level-specific guidance lives next to the round logic and
 * doesn't need to be duplicated across modules.
 */
export function rubricFor(
  roundType: InterviewRoundType,
  level: Level,
): string {
  switch (roundType) {
    case "coding":
      return codingRubric(level);
    case "system_design":
      return systemDesignRubric(level);
    case "behavioral":
      return behavioralRubric(level);
    case "other":
      return otherRubric(level);
  }
}

export { codingRubric, systemDesignRubric, behavioralRubric, otherRubric };
