import { z } from "zod";

import {
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_MIN,
  feedbackStatusSchema,
} from "@/lib/db/schema";

/**
 * Validation schemas for the feedback feature.
 *
 * Kept in their own file so the API route, the persist helper, and
 * unit tests can all share one source of truth without dragging the
 * full `@/lib/db` import surface into every consumer.
 *
 * Length caps live HERE rather than at the DB layer (Postgres TEXT
 * is unbounded) so a future ratchet doesn't require a migration —
 * the next deploy just ships a tightened zod schema and stale
 * over-length rows continue to display fine.
 */

/**
 * Max message length. Long enough to fit a thoughtful paragraph
 * (≈ 300-400 words), short enough that we don't accidentally
 * become a journaling surface.
 */
export const FEEDBACK_MESSAGE_MAX = 2000;

/**
 * Caps on the optional credit fields. Keep them short — these are
 * meant for "Senior PM at Stripe", not for biographies.
 */
export const FEEDBACK_DISPLAY_NAME_MAX = 80;
export const FEEDBACK_DISPLAY_ROLE_MAX = 120;

/**
 * Cap on `page_path`. URL paths in this product are short
 * (`/sessions/<uuid>/edit` is the longest standard route), but a
 * future deep-link might be longer. 512 chars is more than enough
 * and prevents an attacker from smuggling a multi-kilobyte string
 * through this metadata column.
 */
export const FEEDBACK_PAGE_PATH_MAX = 512;

/**
 * Body of `POST /api/feedback`. The widget submits this exact
 * shape. `display_name` / `display_role` are only meaningful when
 * `consent_public` is true — the widget hides those inputs when
 * the checkbox is unchecked, and the server doesn't enforce the
 * dependency: a candidate who provides a display name without
 * consent simply has it stored but never shown publicly.
 */
export const feedbackCreateSchema = z
  .object({
    rating: z
      .number()
      .int()
      .min(FEEDBACK_RATING_MIN, "Rating must be between 1 and 5.")
      .max(FEEDBACK_RATING_MAX, "Rating must be between 1 and 5."),
    message: z
      .string()
      .trim()
      .min(1, "Tell us a bit more.")
      .max(
        FEEDBACK_MESSAGE_MAX,
        `Please keep feedback under ${FEEDBACK_MESSAGE_MAX} characters.`,
      ),
    consentPublic: z.boolean().default(false),
    displayName: z
      .string()
      .trim()
      .max(FEEDBACK_DISPLAY_NAME_MAX)
      .optional()
      .transform((v) => (v === undefined || v.length === 0 ? null : v)),
    displayRole: z
      .string()
      .trim()
      .max(FEEDBACK_DISPLAY_ROLE_MAX)
      .optional()
      .transform((v) => (v === undefined || v.length === 0 ? null : v)),
    pagePath: z
      .string()
      .max(FEEDBACK_PAGE_PATH_MAX)
      .optional()
      .transform((v) => (v === undefined || v.length === 0 ? null : v)),
  })
  .strict();

export type FeedbackCreateInput = z.infer<typeof feedbackCreateSchema>;

/**
 * Body of `PATCH /api/admin/feedback/[id]`. Only the admin queue
 * UI hits this — never the candidate-facing widget. The transition
 * matrix is open (any status can flow to any other status) so a
 * misclick can be reverted without an "unapprove" custom endpoint.
 * The persistence helper stamps `approved_at` / `approved_by_user_id`
 * on the `approved` transition and clears them on a reversal. As a
 * cascade, a transition AWAY from `approved` also clears
 * `featured` / `featured_order` so a home-page featured row never
 * outlives its approval (see `updateFeedbackStatus` for the
 * cascade implementation).
 */
export const feedbackAdminPatchSchema = z
  .object({
    status: feedbackStatusSchema,
    adminNotes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v === undefined || v.length === 0 ? null : v)),
  })
  .strict();

export type FeedbackAdminPatchInput = z.infer<typeof feedbackAdminPatchSchema>;

/**
 * Max number of feedback rows that can be `featured=true` at once.
 * Three to six testimonials is the sweet spot for a marketing home
 * page — more dilutes impact and increases page weight. Enforced at
 * the API edge in `POST /api/admin/feedback/[id]/feature` AND at the
 * UI layer (button disabled with a tooltip when the cap is reached).
 * Not enforced in the DB because future expansion (e.g. a separate
 * "logged-in dashboard" testimonial slot) shouldn't require a
 * migration to lift the cap.
 */
export const FEATURED_TESTIMONIALS_MAX = 6;

/**
 * Body of `POST /api/admin/feedback/[id]/feature`. Drives both the
 * Feature ("show me on the home page") and Unfeature ("remove me")
 * actions — a single boolean keeps the surface minimal. The API
 * layer enforces:
 *
 *   - featured=true requires the row to be status='approved' AND
 *     consent_public=true (rejected with 409 otherwise);
 *   - featured=true counts against `FEATURED_TESTIMONIALS_MAX`
 *     (rejected with 409 if at the cap).
 *
 * The DB CHECK constraint added in migration 0030 is the defence-in-
 * depth backstop for the consent + featured_order half of the
 * invariant.
 */
export const feedbackAdminFeatureSchema = z
  .object({
    featured: z.boolean(),
  })
  .strict();

export type FeedbackAdminFeatureInput = z.infer<
  typeof feedbackAdminFeatureSchema
>;

/**
 * Body of `POST /api/admin/feedback/[id]/move`. Drives the up/down
 * reorder arrows in the admin "Featured" section. A swap with the
 * adjacent featured row in the requested direction; the API is the
 * one that knows what "adjacent" means (the row immediately above
 * or below in featured_order ASC), so the client just says which
 * way to nudge.
 *
 * A move past the start/end of the list is a 200 no-op (idempotent
 * from the client's perspective) — easier to reason about than
 * passing 400s back for clicks the UI didn't disable.
 */
export const feedbackAdminMoveSchema = z
  .object({
    direction: z.enum(["up", "down"]),
  })
  .strict();

export type FeedbackAdminMoveInput = z.infer<typeof feedbackAdminMoveSchema>;
