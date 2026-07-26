import "server-only";

export {
  creditsForDuration,
  isFreeReanalysis,
  freeReanalysisAvailable,
  transcriptionFeeForDelete,
  effectiveCreditBalance,
  formatCreditsDecimal,
  DurationOutOfRangeError,
  MAX_BILLABLE_SECONDS,
  SECONDS_PER_BUCKET,
  RE_ANALYSIS_FREE_WINDOW_MS,
  REANALYSIS_FIXED_CREDIT_COST,
  TRANSCRIPTION_FEE_CREDITS,
  MIN_DURATION_FOR_TRANSCRIPTION_FEE_SECONDS,
  REBUILD_CRITIQUE_UNITS_PER_CREDIT,
  REBUILD_CRITIQUE_CREDIT_COST,
} from "./pricing";

export {
  chargeRebuildCritique,
  previewRebuildCritiqueCost,
  type ChargeRebuildCritiqueArgs,
  type ChargeRebuildCritiqueResult,
  type ChargeRebuildSurface,
  type PreviewRebuildCritiqueCostArgs,
  type PreviewRebuildCritiqueCostResult,
} from "./rebuild-critique";

export {
  consumeCreditsForAnalysis,
  chargeTranscriptionFeeAndDelete,
  refundConsumedCredits,
  InsufficientCreditsError,
  FreeReanalysisAlreadyUsedError,
  SessionStateMismatchError,
  SessionNotFoundError,
  type ConsumeCreditsArgs,
  type ConsumeCreditsResult,
  type ChargeAndDeleteResult,
} from "./consume";

export {
  hasConsumedFreeReanalysis,
  listCreditTransactions,
  listAiUnitCharges,
  type CreditHistoryItem,
  type AiUnitChargeItem,
  type AiUnitChargeSurface,
} from "./queries";

export {
  grantCreditsFromPurchase,
  revokeCreditsFromRefund,
  insertPendingPurchase,
  listRecentPurchases,
  grantFreeTrialCredits,
  type GrantCreditsResult,
  type RevokeCreditsResult,
} from "./grant";
