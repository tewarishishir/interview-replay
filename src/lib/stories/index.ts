import "server-only";

/**
 * Single-import surface for the Story Bank "AI suggested response"
 * feature. Mirrors the `lib/rebuilds` barrel pattern.
 *
 * The bank-surface suggested-response feature shares the LLM
 * pipeline with the rebuild surface (`runSuggestResponse` from
 * `lib/rebuilds/suggest-response.ts`) but persists to the
 * `stories` table directly via this module. See the docstring on
 * `applyStorySuggestedResponse` for the why.
 */

export {
  applyStorySuggestedResponse,
  getStoryForUser,
} from "./persist";

export {
  STORY_SUGGEST_DAILY_CAP,
  StorySuggestRateLimitError,
  assertStorySuggestRateOk,
  countStorySuggestionsInLast24h,
} from "./rate-gate";

export {
  STORY_CRITIQUE_DAILY_CAP,
  STORY_CRITIQUE_AUDIT_EVENT_TYPE,
  STORY_ENHANCE_AUDIT_EVENT_TYPE,
  StoryCritiqueRateLimitError,
  assertStoryCritiqueRateOk,
  countStoryCritiquesInLast24h,
} from "./critique-rate-gate";

export {
  StoryCritiquePreflightError,
  StoryCritiqueValidationError,
  runStoryCritique,
  type StoryCritiqueDraft,
  type RunStoryCritiqueArgs,
  type RunStoryCritiqueResult,
} from "./critique";

export {
  StoryEnhanceValidationError,
  runStoryEnhance,
  STORY_ENHANCE_PROMPT_VERSION,
  type StoryEnhanceDraft,
  type RunStoryEnhanceArgs,
  type RunStoryEnhanceResult,
  type StoryEnhancedDraft,
} from "./enhance";

