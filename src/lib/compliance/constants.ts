/**
 * Compliance flow constants. Centralized so the API routes, the
 * cron jobs, the email templates, and the user-facing copy all
 * reference one source of truth — drifting these between files is
 * how we accidentally email a user "deletion in 30 days" while the
 * cron operates on 7 days.
 */

/**
 * Spec: account deletion has a 30-day grace period during which the
 * user can sign back in to cancel. After this many days, the
 * `hard-delete-accounts` cron runs the full purge.
 */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;
export const ACCOUNT_DELETION_GRACE_MS =
  ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Spec: data-export ZIPs live in storage for this many days, then a daily
 * cron flips the `data_exports` row to `expired` and (defense-in-
 * depth) re-deletes the underlying object regardless of whether the
 * storage lifecycle policy already did.
 */
export const EXPORT_TTL_DAYS = 7;
export const EXPORT_TTL_SECONDS = EXPORT_TTL_DAYS * 24 * 60 * 60;
export const EXPORT_TTL_MS = EXPORT_TTL_SECONDS * 1000;

/**
 * Effective date of the current Terms of Service. Bump this whenever
 * the /terms page changes in any material way; the (app) layout
 * compares it against `users.termsAcceptedAt` and forces a re-
 * acceptance modal when stale.
 *
 * Bumped on 2026-05-16 for the India-only launch: pricing currency
 * change (USD→INR), DPDP Act privacy policy rewrite, India-only
 * restriction in TOS.
 */
export const TERMS_VERSION_DATE = "2026-05-16";

/**
 * Privacy + ops contact surface. Used in Privacy Policy, Terms of
 * Service, and the deletion / export emails. Keep aligned with the
 * domain we ship under (InterviewReplay.ai per spec).
 *
 * `PRIVACY_CONTACT_EMAIL` is also the DPDP-mandated grievance contact
 * (the Data Protection Officer route). Pre-launch this points at a
 * shared inbox the founders monitor; before public launch it must be
 * pointed at the appointed DPO's contact.
 */
export const PRIVACY_CONTACT_EMAIL = "privacy@example.com";
export const SUPPORT_CONTACT_EMAIL = "hello@example.com";

/**
 * Inbox that receives /contact form submissions and in-app feedback
 * internal notifications. Monitored by the founder via Zoho Mail.
 *
 * NOT exposed as a mailto link anywhere on the marketing site — the
 * /contact page is the only path that surfaces it, and the server
 * route is the only thing that writes to it.
 */
export const FEEDBACK_INBOX_EMAIL = "feedback@example.com";

/**
 * Region the product is currently available in. Surfaced in the FAQ
 * and the TOS so a non-Indian visitor sees the restriction up front
 * rather than hitting a payment-rejection later.
 */
export const SERVICE_REGION = "India" as const;

/**
 * Placeholder for the registered office city (used in the TOS
 * governing-law clause). Replace with the real registered office
 * before public launch, once the operating entity is incorporated.
 */
export const REGISTERED_OFFICE_CITY = "Bengaluru";
