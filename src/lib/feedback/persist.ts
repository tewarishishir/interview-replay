import "server-only";

import { db, schema } from "@/lib/db";
import type { Feedback, NewFeedback } from "@/lib/db/schema";

import type { FeedbackCreateInput } from "./schemas";

/**
 * Pure persistence helpers for the feedback feature. Kept one
 * layer below the API routes so unit tests can hit them with a
 * real DB without going through Next, and so a future Server
 * Action variant can share the same code path.
 *
 * Every helper here assumes its caller has already done auth +
 * rate-limit + zod validation — none of that re-runs inside.
 */

/**
 * Insert a fresh row in `status='pending'`. Returns the persisted
 * row so the caller can pull the generated `id` / `createdAt` for
 * the analytics event.
 *
 * Defence in depth against a future code path that smuggles an
 * out-of-range rating around the zod layer: the DB has a CHECK
 * constraint too (see `0029_feedback.sql`), so an invalid row
 * fails the INSERT with `23514` rather than landing in the queue.
 */
export async function createFeedback(args: {
  userId: string;
  data: FeedbackCreateInput;
}): Promise<Feedback> {
  const { userId, data } = args;

  const insertRow: NewFeedback = {
    userId,
    rating: data.rating,
    message: data.message,
    consentPublic: data.consentPublic,
    displayName: data.displayName,
    displayRole: data.displayRole,
    pagePath: data.pagePath,
    // `status` defaults to 'pending' at the DB layer; pass
    // explicitly so the inferred type lines up without a cast.
    status: "pending",
  };

  const [row] = await db
    .insert(schema.feedback)
    .values(insertRow)
    .returning();
  if (!row) {
    throw new Error("createFeedback: INSERT returned no row");
  }
  return row;
}
