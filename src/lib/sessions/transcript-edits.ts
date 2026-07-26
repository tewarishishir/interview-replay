import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import type { Transcript } from "@/lib/db/schema";

/**
 * Server-side helper for `PATCH /api/sessions/:id/transcript`.
 *
 * Two important rules:
 *   1. State guard. Edits are accepted in `review` (pre-analysis,
 *      first-pass cleanup) AND in `complete` (post-analysis, when
 *      the user opens the dedicated edit-and-re-analyze flow). The
 *      `analyzing` state is the one we MUST block — letting an edit
 *      land while the worker is mid-LLM-call would re-ground the
 *      report against text the model never saw. This module
 *      re-asserts ownership via the session join so a forged
 *      sessionId can never persist a write to a row owned by
 *      another user.
 *   2. Edit history. We only update `edited_text` — never `raw_text`
 *      or `redacted_text`. The original transcripts stay immutable
 *      (subject to retention) so a forensic review can still see
 *      the verbatim STT output.
 *
 * Auto-save vs. explicit save: the route is the same for both. The
 * client decides cadence (debounced 1.5 s for auto-save; immediate
 * on "Save edits" click).
 */

/**
 * The set of session states from which the candidate is allowed to
 * mutate `edited_text`. Centralised so the route, the helper, and
 * the SQL guard inside the UPDATE all agree.
 */
const EDITABLE_STATES = ["review", "complete"] as const;
type EditableState = (typeof EDITABLE_STATES)[number];

const isEditableState = (s: string): s is EditableState =>
  (EDITABLE_STATES as readonly string[]).includes(s);

export { EDITABLE_STATES as TRANSCRIPT_EDITABLE_STATES };

export const transcriptEditBodySchema = z.object({
  // 250k characters is comfortably above any realistic transcript
  // (an hour-long round at 150 wpm is ~9k words, ~50k chars). The
  // ceiling exists so a hostile client can't hammer us with
  // megabyte payloads.
  edited_text: z.string().max(250_000),
});

export type TranscriptEditBody = z.infer<typeof transcriptEditBodySchema>;

/**
 * Outcome of `updateTranscriptEdits`. We distinguish the failure
 * modes so the route can return the right HTTP status:
 *   - `not_found`        → 404 (session/transcript missing or not owned)
 *   - `state_conflict`   → 409 (state moved out of `review`
 *                              between the route's pre-check and the
 *                              transactional UPDATE)
 *   - `ok`               → 200 (here's the row)
 *
 * Without the `state_conflict` branch, a concurrent "submit for
 * analysis" advance during an in-flight save would silently land
 * the edit AFTER the analyzer began reading. The race is narrow but
 * easy to close at the SQL layer and the cost of getting it wrong
 * is "edit invisibly applied to a finalized report".
 */
export type TranscriptEditResult =
  | { status: "ok"; transcript: Transcript }
  | { status: "not_found" }
  | { status: "state_conflict" };

/**
 * Apply the candidate's edits.
 */
export async function updateTranscriptEdits(args: {
  sessionId: string;
  userId: string;
  editedText: string;
}): Promise<TranscriptEditResult> {
  return db.transaction(async (tx) => {
    // Confirm (session, user) ownership AND that the row is still in
    // `review`. Done in one read so the UPDATE below can rely on
    // the same observation; the actual race close lives in the
    // UPDATE's WHERE clause (next step).
    const [ownership] = await tx
      .select({
        sessionId: schema.interviewSessions.id,
        state: schema.interviewSessions.state,
      })
      .from(schema.interviewSessions)
      .where(
        and(
          eq(schema.interviewSessions.id, args.sessionId),
          eq(schema.interviewSessions.userId, args.userId),
        ),
      )
      .limit(1);
    if (!ownership) return { status: "not_found" } as const;
    if (!isEditableState(ownership.state)) {
      return { status: "state_conflict" } as const;
    }

    // Guarded UPDATE: the EXISTS sub-select ties the transcript
    // mutation to the session still being in an editable state. If
    // a concurrent transaction advances `interview_sessions.state`
    // (e.g. into `analyzing`) between our SELECT and this UPDATE,
    // the WHERE evaluates to false and we get back zero rows —
    // which we surface as `state_conflict`, not as a silent
    // success.
    const [row] = await tx
      .update(schema.transcripts)
      .set({
        editedText: args.editedText,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.transcripts.sessionId, args.sessionId),
          sql`EXISTS (
            SELECT 1 FROM ${schema.interviewSessions}
            WHERE ${schema.interviewSessions.id} = ${args.sessionId}
              AND ${schema.interviewSessions.state} IN ('review', 'complete')
          )`,
        ),
      )
      .returning();
    if (!row) {
      // Transcript row missing OR state moved between SELECT and
      // UPDATE. We can't tell which one it was without an extra
      // query, but `state_conflict` is the safer bet — the route
      // we previously saw `review` and the transcript existed when
      // we wrote it, so a sub-millisecond state move is the
      // dominant explanation.
      return { status: "state_conflict" } as const;
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.transcript.edited",
      eventData: {
        sessionId: args.sessionId,
        transcriptId: row.id,
        // Lengths only — never write the candidate's edited text
        // into the audit table. That's a separate retention
        // boundary and we don't want to broaden it.
        editedTextLength: args.editedText.length,
      },
    });

    return { status: "ok", transcript: row } as const;
  });
}
