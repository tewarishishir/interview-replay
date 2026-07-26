import "server-only";

import { db, schema } from "@/lib/db";
import type {
  InterviewSession,
  InterviewLevel,
  InterviewRoundType,
} from "@/lib/db/schema";

/**
 * Pure (request-context-free) session-creation helper.
 *
 * Lives in its own module so the API route, the server action, and
 * the tests can all share one code path. Validation is the *caller's*
 * responsibility — `sessionMetadataSchema` + `consent_affirmed: true`
 * are checked at the route boundary; this function trusts its
 * arguments and just writes the row + the matching audit log entry
 * inside a single transaction.
 *
 * Both writes go in one transaction because if the session insert
 * succeeds but the audit row fails (or vice versa) we'd be missing a
 * piece of the compliance trail. Rolling both back is the only safe
 * default.
 */

export interface CreateSessionInput {
  userId: string;
  companyName: string;
  roleTitle: string;
  level: InterviewLevel;
  roundType: InterviewRoundType;
  scheduledAt: Date | null;
  /**
   * Optional request metadata. The audit trail loses most of its
   * compliance value if the IP / user-agent of the consenting client
   * isn't recorded, so callers should pass these through whenever
   * they have them.
   */
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<InterviewSession> {
  const consentAffirmedAt = new Date();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.interviewSessions)
      .values({
        userId: input.userId,
        companyName: input.companyName,
        roleTitle: input.roleTitle,
        level: input.level,
        roundType: input.roundType,
        scheduledAt: input.scheduledAt,
        // Explicit `state: 'created'` instead of relying on the
        // default — keeps the intent visible at the call site and
        // means a future schema migration that changes the default
        // can't silently break this flow.
        state: "created",
        consentAffirmedAt,
      })
      .returning();

    if (!row) {
      // RETURNING on an INSERT shouldn't be empty unless something
      // serious went wrong (e.g. the table was dropped). Throwing
      // rolls the transaction back so we never write the audit row
      // for a session that doesn't exist.
      throw new Error("createSession: INSERT returned no row");
    }

    await tx.insert(schema.auditLog).values({
      userId: input.userId,
      eventType: "session.created",
      eventData: {
        sessionId: row.id,
        companyName: row.companyName,
        roleTitle: row.roleTitle,
        level: row.level,
        roundType: row.roundType,
        scheduledAt: row.scheduledAt?.toISOString() ?? null,
        consentAffirmedAt: consentAffirmedAt.toISOString(),
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    return row;
  });
}
