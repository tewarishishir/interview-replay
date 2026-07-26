import { getApprovedTestimonials } from "@/lib/feedback/queries";
import { FEATURED_TESTIMONIALS_MAX } from "@/lib/feedback/schemas";

import { TestimonialCard } from "./testimonial-card";

/**
 * Marketing-home-page testimonials section. Server component:
 * fetches featured rows at request time and renders the grid.
 *
 * Behaviour:
 *   - Zero featured rows → renders nothing (no empty section).
 *     The home page should look complete whether or not the
 *     curation tray has anything in it.
 *   - 1+ featured rows → renders a heading + responsive grid
 *     (1 col mobile / 2 col md / 3 col lg).
 *
 * Position on the home page: between "How it works" and the
 * "Pricing teaser" — social proof immediately before the ask is
 * the strongest position.
 *
 * Caching: the page already opts into per-request session lookup
 * (`await auth()` in the parent), so this section piggybacks on
 * the same dynamic render. Freshness: new featured rows appear on
 * the next page load — no revalidate interval needed.
 */
export async function Testimonials() {
  const rows = await getApprovedTestimonials({
    limit: FEATURED_TESTIMONIALS_MAX,
  });

  if (rows.length === 0) return null;

  return (
    <section
      id="testimonials"
      aria-labelledby="testimonials-heading"
      className="border-t border-border"
    >
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="testimonials-heading"
            className="text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            What people are saying
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            A few candidates who used InterviewReplay to prep for real
            interviews — in their own words.
          </p>
        </div>

        <ul
          className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Testimonials from InterviewReplay users"
        >
          {rows.map((row) => (
            <li key={row.id} className="flex">
              <TestimonialCard
                imageUrl={row.imageUrl}
                displayName={row.displayName}
                displayRole={row.displayRole}
                rating={row.rating}
                message={row.message}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * JSON-LD Review objects to splice into the page's existing
 * `SoftwareApplication` schema. Returned separately so the marketing
 * page can compose them into one schema block (multiple `Review`
 * children of a single `SoftwareApplication`) rather than emitting
 * a flat list of orphan reviews — search engines treat reviews-of-a-
 * product more strictly than free-floating ones.
 *
 * Returns `null` when there are no featured rows so the page can
 * skip rendering the review key entirely (an empty `review: []`
 * array is technically valid JSON-LD but a missing key is cleaner).
 */
export async function getTestimonialsReviewSchema(): Promise<
  | Array<{
      "@type": "Review";
      reviewRating: { "@type": "Rating"; ratingValue: number; bestRating: 5 };
      author: { "@type": "Person"; name: string };
      reviewBody: string;
    }>
  | null
> {
  const rows = await getApprovedTestimonials({
    limit: FEATURED_TESTIMONIALS_MAX,
  });
  if (rows.length === 0) return null;
  return rows.map((row) => ({
    "@type": "Review" as const,
    reviewRating: {
      "@type": "Rating" as const,
      ratingValue: row.rating,
      bestRating: 5 as const,
    },
    author: {
      "@type": "Person" as const,
      // Schema.org wants a person name. Fall back to a generic
      // "InterviewReplay user" when both the chosen credit AND the OAuth
      // name are empty so we don't emit `name: ""` (Google rejects
      // empty review.author.name as invalid markup).
      name: row.displayName?.trim() || "InterviewReplay user",
    },
    reviewBody: row.message,
  }));
}
