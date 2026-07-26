import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { interviewSessions } from "./interviews";

/**
 * Self-reported outcome of an interview, attached to a `complete`
 * session. The user records what the company actually did
 * (advanced / offer / rejected / etc.) plus optional reflection
 * text. This data is the seed for the v1.5 longitudinal coaching
 * feature — joined per-user against `interview_sessions` (company,
 * role, level, round_type) and `reports.report_json` it lets the
 * product show "you flagged X as a weakness, and the rounds you
 * were rejected on tend to share these signals".
 *
 * IMPORTANT product principle (load-bearing in the report UI):
 * the outcome NEVER modifies, contradicts, or annotates the
 * existing AI report. It's strictly additive context. The original
 * analysis stays exactly as the LLM produced it; we don't
 * retroactively pretend the call was better or worse based on the
 * result. See `outcome-card.tsx` for how the UI enforces this
 * (separate card, separate visual treatment, the report content
 * itself is untouched).
 *
 * Encryption posture: the three free-text columns
 * (`feedback_received`, `reflection_notes`, `would_change`) are
 * stored as plain TEXT, matching the existing posture for
 * transcripts and reports — TLS in transit + Postgres at-rest +
 * filesystem encryption at rest. App-layer envelope encryption is
 * a tracked follow-up that should be retrofitted to transcripts
 * and outcomes together so they share one key-management surface.
 */

/**
 * Constrained set of outcome types. Stored as TEXT (with a CHECK
 * constraint, see migration) rather than `pgEnum` so we can add
 * new categories — e.g. "ghosted_after_offer" — with a single SQL
 * statement rather than the destructive type rewrite Postgres
 * enums require for additions in the middle of the list.
 *
 * Order here is the order shown in the UI.
 */
export const OUTCOME_TYPES = [
  "advanced_to_next_round",
  "received_offer",
  "did_not_advance",
  "withdrew",
  "no_response",
  "other",
] as const;
export const outcomeTypeSchema = z.enum(OUTCOME_TYPES);
export type OutcomeType = z.infer<typeof outcomeTypeSchema>;

/**
 * 1:1 with `interview_sessions` (UNIQUE on `session_id`). The
 * outcome is the latest, most current piece of information about
 * the round, so it gets a single row that we PATCH/DELETE rather
 * than a history table — for the "I entered it wrong" case the UI
 * surfaces an Edit button. The longitudinal feature does not need
 * a history of edits; the latest value is the truth.
 */
export const sessionOutcomes = pgTable(
  "session_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),

    /**
     * One of `OUTCOME_TYPES`. Stored as TEXT + a CHECK constraint
     * (see migration) — see the comment at the top of this file
     * for why this isn't a `pgEnum`.
     */
    outcomeType: text("outcome_type").notNull(),

    /**
     * When the user heard back from the company. Distinct from
     * `recordedAt` — they may add the outcome to InterviewReplay days or
     * weeks after they got the email. NULL when the user doesn't
     * remember / hasn't heard back (e.g. `no_response` outcomes
     * may legitimately have no date).
     */
    outcomeReceivedAt: timestamp("outcome_received_at", {
      withTimezone: true,
    }),

    /**
     * When the user added this row to InterviewReplay. Defaulted to now()
     * at the DB layer so we have a deterministic timestamp even if
     * the application clock drifts. Used by the reminder job's
     * "did we already prompt this user?" check via the audit log,
     * NOT by selecting on this column.
     */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * If `outcome_type = 'advanced_to_next_round'`, what's the
     * next round? Free text; the UI suggests a few examples
     * ("System design with hiring manager", "Onsite loop", "Final
     * round with VP") but doesn't constrain. NULL for any other
     * outcome type. The application layer enforces this; the DB
     * does not (the constraint is purely behavioural — we want to
     * be able to capture "I'm advancing but I don't know the
     * next round yet" cleanly, which is `next_round_type IS NULL`).
     */
    nextRoundType: text("next_round_type"),

    /**
     * Verbatim feedback the company gave the user. Pasted from a
     * recruiter email, transcribed from a phone debrief, etc.
     * Sensitive: the user trusts us with what an interviewer
     * actually said, and that text might quote them by name.
     * See encryption posture in the file-level comment.
     */
    feedbackReceived: text("feedback_received"),

    /**
     * The user's own retrospective notes. "What do you think
     * actually happened? What surprised you?" — this is the
     * candidate-side complement to `feedback_received`.
     */
    reflectionNotes: text("reflection_notes"),

    /**
     * One-line "if you could redo this interview, what's the one
     * thing you'd change?". Especially valuable for the
     * longitudinal feature — it's the user's own retrospective,
     * which often diverges interestingly from what the AI flagged.
     * Capped at 500 chars at the API edge.
     */
    wouldChange: text("would_change"),

    /**
     * Whether the user asked the company for feedback after the
     * outcome. Longitudinal coaching signal: candidates who ask
     * consistently get better feedback loops. Defaults FALSE;
     * recorded explicitly only when the user checks the toggle
     * in the outcome form.
     */
    askedForFeedback: boolean("asked_for_feedback").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 1:1 with sessions. The reverse lookup ("does this session
    // have an outcome?") and the API uniqueness guard both ride on
    // this index — the API's POST handler relies on a 23505 unique
    // violation to enforce the 'one outcome per session' rule
    // without a SELECT-then-INSERT race window.
    uniqueIndex("session_outcomes_session_id_uniq").on(table.sessionId),

    // For the v1.5 longitudinal feature: list a user's outcomes
    // newest-first by joining `interview_sessions(user_id)` and
    // ordering by recorded_at. We index on `recorded_at` here even
    // though the join is on `session_id` because the secondary
    // sort dominates the query plan once a power user has dozens
    // of outcomes.
    index("session_outcomes_recorded_idx").on(table.recordedAt.desc()),

    // Reminder job's per-tick scan: find sessions that need a
    // reminder. We don't scan this table for that — we scan
    // `interview_sessions` LEFT JOIN session_outcomes, so the
    // negative-existence check rides the unique index above. No
    // extra index needed for the reminder path.
    //
    // The CHECK constraint enforcing the allowed `outcome_type`
    // values is added in the SQL migration directly so callers
    // who bypass the Zod layer (manual SQL, future legacy
    // migrations) can't insert a typo.
  ],
);

export type SessionOutcome = typeof sessionOutcomes.$inferSelect;
export type NewSessionOutcome = typeof sessionOutcomes.$inferInsert;
