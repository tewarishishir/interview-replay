import "server-only";

/**
 * Single-import surface for the Practice Rebuild feature.
 *
 * API routes and components import from here so the underlying
 * file layout can change (split a module, rename a helper,
 * etc.) without rippling across call sites. Mirrors the
 * `lib/llm` and `lib/profiles` barrel pattern.
 */

export {
  createRebuild,
  patchRebuild,
  applyCritique,
  applySuggestedResponse,
  discardRebuild,
  type WriteOutcome,
} from "./persist";

export {
  countInFlightRebuilds,
  findInProgressRebuildForImprovement,
  getRebuild,
  listRebuilds,
  listRebuildsForSession,
} from "./queries";

export {
  toRebuildDto,
  toSavedToBankDto,
  toStoryDto,
  type RebuildDto,
  type SavedToBankDto,
  type StoryDto,
} from "./dto";

export {
  createRebuildBodySchema,
  patchRebuildBodySchema,
  listRebuildsQuerySchema,
  critiqueResponseSchema,
  dimensionFeedbackSchema,
  profileReferenceSchema,
  suggestedResponseSchema,
  suggestionSourceSchema,
  CRITIQUE_DIMENSIONS,
  CRITIQUE_STATUSES,
  type CreateRebuildInput,
  type PatchRebuildInput,
  type ListRebuildsQuery,
  type CritiqueResponse,
  type CritiqueDimension,
  type CritiqueStatus,
  type DimensionFeedback,
  type ProfileReference,
  type SuggestedResponse,
  type SuggestionSource,
} from "./schemas";

export {
  loadRebuildProfileContext,
  renderProfileContext,
  type RebuildProfileContext,
} from "./profile-context";

export {
  REBUILD_PROMPT_VERSION,
  REBUILD_SYSTEM_PROMPT,
  renderRebuildUserPrompt,
} from "./prompt";

export {
  SUGGEST_PROMPT_VERSION,
  SUGGEST_SYSTEM_PROMPT,
  renderSuggestUserPrompt,
} from "./suggest-prompt";

export {
  RebuildSuggestValidationError,
  findHallucinatedSources,
  parseAndValidateSuggestion,
  runSuggestResponse,
  type RunSuggestResponseArgs,
  type RunSuggestResponseResult,
  type SuggestionContext,
} from "./suggest-response";

export {
  GUARDRAIL_EVENTS,
  buildFallbackCritique,
  findExampleSentence,
  hasOwnershipPhrase,
  normalizeForVerbatim,
  profileContains,
  runGuardrails,
  type GuardrailEvent,
  type GuardrailFailure,
  type GuardrailResult,
} from "./guardrails";

export {
  EnhanceValidationError,
  ENHANCE_PROMPT_VERSION,
  runEnhance,
  type EnhancedDraft,
  type RunEnhanceArgs,
  type RunEnhanceResult,
} from "./enhance";

export {
  isFailureShaped,
  parseAndValidate,
  preflightDraft,
  RebuildCritiquePreflightError,
  RebuildCritiqueValidationError,
  runCritique,
  type RunCritiqueArgs,
  type RunCritiqueResult,
} from "./critique";

export {
  CRITIQUE_DAILY_CAP,
  SUGGEST_DAILY_CAP,
  RebuildCritiqueRateLimitError,
  RebuildSuggestRateLimitError,
  assertCritiqueRateOk,
  assertSuggestedResponseRateOk,
  countCritiquesInLast24h,
  countSuggestionsInLast24h,
} from "./critique-rate-gate";

export {
  RebuildAlreadyPromotedError,
  RebuildDiscardedError,
  RebuildNotReadyToSaveError,
  RebuildVanishedError,
  StoryBankLimitExceededError,
  mapRebuildThemeToStoryTheme,
  saveRebuildToBank,
  type SaveRebuildToBankResult,
} from "./save-to-bank";
