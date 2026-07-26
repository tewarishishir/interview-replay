import "server-only";

export {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_CODE_LENGTH,
} from "./code";

export {
  setReferralCodeOnTx,
  ensureReferralCodeForUser,
} from "./persist";

export {
  resolveReferrerByCode,
  setReferredByOnTx,
} from "./attribution";

export { awardReferrerOnFirstPurchase } from "./award";

export {
  getReferralStats,
  buildReferralLink,
  type ReferralStats,
} from "./queries";

/**
 * Cookie name used by the OAuth signup flow to carry the
 * `?ref=CODE` value across the Google round-trip. Read once in
 * `events.createUser`, then immediately cleared (it has done its
 * job at that point).
 *
 * Short-lived (15 minutes) so a stale cookie from an abandoned
 * signup doesn't accidentally attribute a future signup. The
 * cookie value is the raw code — `normalizeReferralCode` validates
 * the shape on read, and `resolveReferrerByCode` validates that
 * the code points at a real user.
 */
export const REFERRAL_COOKIE_NAME = "ir_ref";
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 15 * 60;
