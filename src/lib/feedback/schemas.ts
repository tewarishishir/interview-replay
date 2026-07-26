import { z } from "zod";

import {
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_MIN,
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
 * Max number of feedback rows that can be `featured=true` at once.
 * Three to six testimonials is the sweet spot for a marketing home
 * page — more dilutes impact and increases page weight. Not enforced
 * in the DB because future expansion (e.g. a separate "logged-in
 * dashboard" testimonial slot) shouldn't require a migration to lift
 * the cap.
 */
export const FEATURED_TESTIMONIALS_MAX = 6;
