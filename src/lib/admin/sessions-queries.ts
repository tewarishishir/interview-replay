import "server-only";

import { asc, desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  Artifact,
  InterviewSession,
  Transcript,
} from "@/lib/db/schema";

/**
 * Read-only queries powering the `/admin/sessions/[id]` surface.
 *
 * Like all admin queries, these bypass the user-ownership filter.
 * The `(admin)` layout already gates `is_admin = true` on every
 * request; everything here trusts that gate and reads any session
 * by id without a userId constraint.
 */

export interface AdminSessionBundle {
  session: InterviewSession;
  ownerEmail: string;
  ownerDisplayName: string | null;
  ownerId: string;
  transcript: Transcript | null;
  artifacts: Artifact[];
  reports: AdminReportRow[];
  outcome: AdminOutcomeRow | null;
}

export interface AdminReportRow {
  id: string;
  reportJson: unknown;
  modelVersion: string | null;
  rubricVersion: string | null;
  createdAt: Date;
}

export interface AdminOutcomeRow {
  outcomeType: string;
  outcomeReceivedAt: Date | null;
  recordedAt: Date;
  nextRoundType: string | null;
  feedbackReceived: string | null;
}

/**
 * Fetches the full session bundle for admin inspection.
 * Returns null if the session doesn't exist (no soft-deleted
 * sessions either — same 404 semantics as the user-facing query).
 */
export async function getAdminSessionBundle(
  sessionId: string,
): Promise<AdminSessionBundle | null> {
  const [sessionRow] = await db
    .select()
    .from(schema.interviewSessions)
    .where(eq(schema.interviewSessions.id, sessionId))
    .limit(1);

  if (!sessionRow || sessionRow.deletedAt) return null;

  const [
    [transcript],
    artifacts,
    reports,
    [outcomeRow],
    [ownerRow],
  ] = await Promise.all([
    db
      .select()
      .from(schema.transcripts)
      .where(eq(schema.transcripts.sessionId, sessionId))
      .limit(1),

    db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, sessionId))
      .orderBy(
        asc(schema.artifacts.displayOrder),
        asc(schema.artifacts.createdAt),
      ),

    db
      .select({
        id: schema.reports.id,
        reportJson: schema.reports.reportJson,
        modelVersion: schema.reports.modelVersion,
        rubricVersion: schema.reports.rubricVersion,
        createdAt: schema.reports.createdAt,
      })
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, sessionId))
      .orderBy(desc(schema.reports.createdAt)),

    db
      .select({
        outcomeType: schema.sessionOutcomes.outcomeType,
        outcomeReceivedAt: schema.sessionOutcomes.outcomeReceivedAt,
        recordedAt: schema.sessionOutcomes.recordedAt,
        nextRoundType: schema.sessionOutcomes.nextRoundType,
        feedbackReceived: schema.sessionOutcomes.feedbackReceived,
      })
      .from(schema.sessionOutcomes)
      .where(eq(schema.sessionOutcomes.sessionId, sessionId))
      .limit(1),

    db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.users)
      .where(eq(schema.users.id, sessionRow.userId))
      .limit(1),
  ]);

  return {
    session: sessionRow,
    ownerEmail: ownerRow?.email ?? "(unknown)",
    ownerDisplayName: ownerRow?.name ?? null,
    ownerId: sessionRow.userId,
    transcript: transcript ?? null,
    artifacts,
    reports,
    outcome: outcomeRow
      ? {
          outcomeType: outcomeRow.outcomeType,
          outcomeReceivedAt: outcomeRow.outcomeReceivedAt,
          recordedAt: outcomeRow.recordedAt,
          nextRoundType: outcomeRow.nextRoundType,
          feedbackReceived: outcomeRow.feedbackReceived,
        }
      : null,
  };
}
