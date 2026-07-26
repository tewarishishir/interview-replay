/**
 * Allowlist of analytics event names. Centralizing them here:
 *
 *   1. Stops the client and server sides from drifting in their
 *      naming (a typo on the client maps to a different event in
 *      analytics and our funnels silently break).
 *   2. Gives a grep-able single source for "what do we send to
 *      analytics" — useful for the privacy policy.
 *   3. Makes adding a new event a one-line diff that lints the
 *      consumers via the discriminated `AnalyticsEvent` type.
 *
 * Never include transcript or report content in the properties
 * payload. Anything user-typed is unsafe; only IDs, counts, and
 * round-type / level enums are safe to ship.
 */

export const ANALYTICS_EVENTS = {
  signup: "user_signed_up",
  activation: "user_activated_first_session",
  purchase: "credit_purchase_succeeded",
  sessionCreated: "session_created",
  sessionCompleted: "session_completed",
  reportViewed: "report_viewed",
  accountDeleted: "account_deletion_initiated",
  exportRequested: "data_export_requested",

  // Interview Outcome feature. The four events here are the only
  // ones the outcome surface emits — see `lib/sessions/outcomes.ts`
  // and `components/app/outcome-*` for call sites. We deliberately
  // do NOT emit anything that would carry user-typed text
  // (feedback_received / reflection_notes / would_change); the
  // `outcome_recorded` payload is enums + booleans only.
  outcomeRecorded: "outcome_recorded",
  outcomeReminderSent: "outcome_reminder_sent",
  outcomeReminderClicked: "outcome_reminder_clicked",
  outcomeSectionViewedWithoutRecording: "outcome_section_viewed_without_recording",

  // Practice Rebuild feature. Each rebuild step has one event so the
  // funnel can answer "how many users started a rebuild → ran a
  // critique → saved to bank". Health metrics (see PRD):
  //   - profile_suggestion_actioned rate >80%: AI may be too pushy
  //   - profile_suggestion_actioned rate <20%: suggestions may not be useful
  //   - guardrail trip rate >2%: model drifting from coaching to generation
  //
  // We also track each guardrail trip distinctly so we can tell
  // "the model is producing example sentences" from "the model is
  // hallucinating profile content" — they suggest different fixes.
  rebuildStarted: "rebuild_started",
  rebuildStepCompleted: "rebuild_step_completed",
  rebuildProfilePulled: "rebuild_profile_pulled",
  rebuildCritiqueRequested: "rebuild_critique_requested",
  rebuildProfileLeverageSurfaced: "rebuild_profile_leverage_surfaced",
  rebuildProfileDiscrepancyFlagged: "rebuild_profile_discrepancy_flagged",
  rebuildProfileSuggestionActioned: "rebuild_profile_suggestion_actioned",
  rebuildSavedToBank: "rebuild_saved_to_bank",
  rebuildDiscarded: "rebuild_discarded",
  rebuildGuardrailTripped: "rebuild_guardrail_tripped",

  // "AI suggested response" feature — the user clicks "Generate AI
  // draft" on the rebuild flow or a bank card and we ship them a
  // STAR-format draft drawn from their profile to compare against.
  // We track both surfaces separately so the funnel can split
  // "generated during the rebuild flow" vs. "generated from the
  // bank card after the fact".
  rebuildEnhanceApplied: "rebuild_enhance_applied",
  rebuildSuggestedResponseRequested: "rebuild_suggested_response_requested",
  rebuildSuggestedResponseViewedOnStory: "rebuild_suggested_response_viewed_on_story",
  rebuildSuggestedResponseGuardrailTripped:
    "rebuild_suggested_response_guardrail_tripped",

  // Story Bank top-level page. Surfaces both the IA promotion
  // signal (page traffic vs. the old in-profile section) and the
  // rebuild-context engagement signal (how often candidates open
  // their saved AI critique vs. just viewing the STAR text).
  storyBankViewed: "story_bank_viewed",
  storyCritiqueExpanded: "story_critique_expanded",
  storyJumpToSession: "story_jump_to_session",

  // Bank-surface "AI suggested response" feature. Hand-authored
  // stories don't have a backing rebuild row; this surface lets
  // the user generate a draft against a saved story directly.
  // Tracked separately from `rebuildSuggestedResponse*` so the
  // funnel can answer "did adding this affordance to the bank
  // shift generation volume off the rebuild flow" without losing
  // the existing baseline.
  storySuggestedResponseRequested: "story_suggested_response_requested",
  storySuggestedResponseGuardrailTripped:
    "story_suggested_response_guardrail_tripped",
  storyDraftGenerated: "story_draft_generated",
  storyCritiqueRequested: "story_critique_requested",
  storyEnhanceApplied: "story_enhance_applied",

  // Per-session Analytics tab (Prompt 3). Three events split the
  // funnel: the user landing on the tab (denominator), per-question
  // card click-through (engagement signal), and the rebuild
  // launch path the tab specifically drives. Properties are
  // metadata-only (ids, counts, enums) — no transcript content.
  sessionAnalyticsTabViewed: "session_analytics_tab_viewed",
  sessionAnalyticsQuestionClicked: "session_analytics_question_clicked",
  sessionAnalyticsRebuildClicked: "session_analytics_rebuild_clicked",

  // Visual-refinement pass (per-question card collapse/expand,
  // top-of-report InterviewReplay'ed read TL;DR, quieter outcome card).
  // These complement the three `sessionAnalytics*` events above
  // — the per-question expand/collapse pair lets the funnel
  // measure how often a user actually opens a card to read the
  // metrics under the fold (separate signal from "they clicked
  // the row to scroll to the transcript", which is the prior
  // `sessionAnalyticsQuestionClicked` semantic).
  //
  // `outcomeRecordClickedFromQuietState` replaces the implicit
  // click-tracking on the outcome card's primary CTA — naming it
  // explicitly keeps the funnel honest about whether the quieter
  // empty-state styling actually got fewer clicks (and therefore
  // helped or hurt outcome-record rates).
  perQuestionCardExpanded: "per_question_card_expanded",
  perQuestionCardCollapsed: "per_question_card_collapsed",
  aiReadTopTldrViewed: "ai_read_top_tldr_viewed",
  aiReadFullLinkClicked: "ai_read_full_link_clicked",
  outcomeRecordClickedFromQuietState:
    "outcome_record_clicked_from_quiet_state",

  // Speech pace gauge in the Communication section (final Analytics
  // piece). Fires once on Communication-section mount whenever the
  // gauge is actually rendered (skipped on zero-duration / zero-
  // word transcripts where the gauge returns null). Properties are
  // metadata-only: the integer WPM value and the descriptive band
  // — no transcript text.
  speechPaceGaugeViewed: "speech_pace_gauge_viewed",

  // Admin dashboard surface (founder-only). Track to keep the
  // founder honest about how often they actually use the dashboards
  // — if these events stop firing, the operator has lost touch with
  // the product. Properties are metadata-only (counts, action types,
  // filter strings) — never user-typed content.
  adminOpsViewed: "admin_ops_viewed",
  adminUsersViewed: "admin_users_viewed",
  adminUserDetailViewed: "admin_user_detail_viewed",
  // Alias for `adminUserDetailViewed` used by the detail-page render path.
  // The two names map to the same event string; the alias exists so the
  // call sites can read more naturally.
  adminUserViewed: "admin_user_detail_viewed",
  adminHealthViewed: "admin_health_viewed",
  adminActionTaken: "admin_action_taken",

  // Feedback widget submissions. One server-side event per accepted
  // POST /api/feedback (after the row is persisted). Properties are
  // metadata only — rating, message length, consent flag, and the
  // path the widget was opened from. The message body itself is
  // NEVER shipped to analytics (it's user-typed text; see the file
  // header for why that's a hard rule).
  feedbackSubmitted: "feedback_submitted",

  // Free-trial funnel events (India launch). Measure:
  //   - activation: % of signups that consume at least one free credit
  //   - free-to-paid: % of users who exhaust free credits and then purchase
  //   - time-to-purchase: median days from signup to first paid purchase
  // Names match the spec verbatim so the dashboards line up.
  freeCreditsGranted: "free_credits_granted",
  firstCreditConsumed: "first_credit_consumed",
  freeCreditsExhausted: "free_credits_exhausted",
  firstPaidPurchase: "first_paid_purchase",

  // Sample report marketing page. Two events drive the conversion
  // funnel: did the visitor see the sample, and did they click
  // through to sign up? Healthy state: sample-to-signup conversion
  // above 10%. Below 5% signals the page isn't doing its job.
  sampleReportViewed: "sample_report_viewed",
  sampleReportSignupClicked: "sample_report_signup_clicked",
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

export type AnalyticsProperties = Record<
  string,
  string | number | boolean | null
>;

/**
 * URL paths considered sensitive. These paths contain user interview
 * content and should not be autocaptured by any analytics provider.
 */
export const SENSITIVE_PATH_PREFIXES = [
  "/sessions",
  "/account",
  "/rebuilds",
] as const;

export function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}
