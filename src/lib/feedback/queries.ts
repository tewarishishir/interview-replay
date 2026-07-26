import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { Feedback } from "@/lib/db/schema";

/**
 * Read helpers for the user-facing surfaces of the feedback
 * feature. Currently serves the home-page testimonials section
 * (`src/app/(marketing)/page.tsx`).
 *
 * The query rides the partial index `feedback_featured_idx` so the
 * cost is bounded by the (small, admin-capped) row count of featured
 * testimonials, not the row count of the whole table.
 */

export interface TestimonialRow {
  id: string;
  rating: number;
  message: string;
  /** Either the user's chosen credit (`feedback.display_name`) or
   *  their OAuth display name as a fallback. May be null if both
   *  are empty (rare — OAuth providers almost always supply a name). */
  displayName: string | null;
  /** User's chosen role line, e.g. "Senior PM at Acme". Optional. */
  displayRole: string | null;
  /** OAuth profile image URL (Google etc.). Nullable for users who
   *  signed up via email/password. The render layer falls back to
   *  initials when this is null OR when the URL 404s at fetch time. */
  imageUrl: string | null;
  approvedAt: Date;
}

/**
 * Featured + approved + consent-public testimonials for the home
 * page, in the admin-set order (featured_order ASC), with
 * approved_at DESC as a tiebreaker when admins leave ties.
 *
 * Joins `users` for the profile image and a fallback display name
 * so the render surface is purely presentational — no follow-up
 * fetches needed.
 *
 * Returns only the columns the public surface should render — the
 * inferred select keeps the surface area small and audit-friendly
 * (no admin commentary or submitter identity leak into the page by
 * accident).
 */
export async function getApprovedTestimonials(args: {
  limit: number;
}): Promise<TestimonialRow[]> {
  const rows = await db
    .select({
      id: schema.feedback.id,
      rating: schema.feedback.rating,
      message: schema.feedback.message,
      // Prefer the user's chosen testimonial credit; fall back to
      // their OAuth display name. Coalescing in SQL keeps the
      // render layer simple and lets the partial index plan stay
      // intact.
      displayName: schema.feedback.displayName,
      fallbackName: schema.users.name,
      displayRole: schema.feedback.displayRole,
      imageUrl: schema.users.image,
      approvedAt: schema.feedback.approvedAt,
    })
    .from(schema.feedback)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.feedback.userId),
    )
    .where(
      and(
        eq(schema.feedback.status, "approved"),
        eq(schema.feedback.consentPublic, true),
        eq(schema.feedback.featured, true),
      ),
    )
    .orderBy(
      asc(schema.feedback.featuredOrder),
      desc(schema.feedback.approvedAt),
    )
    .limit(args.limit);

  // The WHERE clause filters to status='approved' AND featured=true,
  // which (combined with the CHECK constraint added in migration
  // 0030) implies `approved_at IS NOT NULL` and `featured_order IS
  // NOT NULL`. The narrow below is a pure TS narrow.
  return rows
    .filter(
      (r): r is typeof r & { approvedAt: Date } => r.approvedAt !== null,
    )
    .map((r) => ({
      id: r.id,
      rating: r.rating,
      message: r.message,
      displayName: r.displayName ?? r.fallbackName ?? null,
      displayRole: r.displayRole,
      imageUrl: r.imageUrl,
      approvedAt: r.approvedAt,
    }));
}

// Re-exported `Feedback` type for callers that want the full
// row shape (none yet — kept for symmetry with the future
// "my feedback" surface).
export type { Feedback };
