import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  Artifact,
  ArtifactType,
  InterviewSession,
  Transcript,
} from "@/lib/db/schema";

/**
 * Read-side helpers for the review/augment screens.
 *
 * The user-facing entry point is `getSessionForReview(sessionId,
 * userId)` which returns the session + transcript + artifacts in
 * one call. Splitting it into three round-trips would be cheap
 * latency-wise but the page only ever wants the bundle, and a
 * single helper keeps the ownership-and-state guard logic in one
 * place.
 *
 * Every read takes `userId` and pins the WHERE on it. Returning
 * `null` for "no such row" AND "owned by someone else" matches the
 * existing `getSession` contract.
 */

export interface SessionReviewBundle {
  session: InterviewSession;
  transcript: Transcript | null;
  artifacts: Artifact[];
}

export async function getSessionForReview(
  sessionId: string,
  userId: string,
): Promise<SessionReviewBundle | null> {
  const [session] = await db
    .select()
    .from(schema.interviewSessions)
    .where(
      and(
        eq(schema.interviewSessions.id, sessionId),
        eq(schema.interviewSessions.userId, userId),
      ),
    )
    .limit(1);
  if (!session) return null;

  // Soft-deleted sessions aren't reviewable. We treat them the same
  // as missing — the UI route maps a null bundle to a 404.
  if (session.deletedAt) return null;

  // Transcript and artifacts are independent — fetch in parallel
  // rather than sequentially to halve the round-trip count.
  const [[transcript], artifacts] = await Promise.all([
    db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, sessionId))
      .limit(1),
    db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, sessionId))
      .orderBy(asc(schema.artifacts.displayOrder), asc(schema.artifacts.createdAt)),
  ]);

  return {
    session,
    transcript: transcript ?? null,
    artifacts,
  };
}

/**
 * Single-row artifact lookup, scoped to (artifactId, sessionId,
 * userId). Used by the PATCH/DELETE routes to enforce ownership
 * before they touch the row. Returning the row (rather than just
 * `true`) lets the caller see the previous state for audit logging.
 */
export async function getOwnedArtifact(args: {
  artifactId: string;
  sessionId: string;
  userId: string;
}): Promise<Artifact | null> {
  // Inner-join on `interview_sessions` so the userId predicate is
  // applied against the session, which is the authoritative owner —
  // artifacts don't carry a userId column.
  //
  // The select projects every column on `artifacts` so callers that
  // need the AI-inferred fields (`source`, `aiConfidence`,
  // `userConfirmedAt`, `dismissedAt`, …) don't have to round-trip
  // back to the DB. The cost is a single extra column per row,
  // which is dominated by the network/parse overhead either way.
  const [row] = await db
    .select()
    .from(schema.artifacts)
    .innerJoin(
      schema.interviewSessions,
      eq(schema.artifacts.sessionId, schema.interviewSessions.id),
    )
    .where(
      and(
        eq(schema.artifacts.id, args.artifactId),
        eq(schema.artifacts.sessionId, args.sessionId),
        eq(schema.interviewSessions.userId, args.userId),
      ),
    )
    .limit(1);
  return (row?.artifacts as Artifact | undefined) ?? null;
}

/**
 * Artifact-type narrowing helper used by tests and helpers — the
 * inferred type of `Artifact.artifactType` is `ArtifactType` (the
 * full DB enum), so a switch statement on it doesn't get exhaustive
 * checking against the `ACTIVE_ARTIFACT_TYPES` list. This re-export
 * exists to make that symmetry obvious to readers.
 */
export type { ArtifactType };
