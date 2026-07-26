import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { users } from "./users";

/**
 * Lifecycle of an interview from "candidate created the row" through
 * "report delivered" through "data scrubbed for retention". States are a
 * Postgres enum so a typo at the SQL layer becomes a hard error rather
 * than silently corrupting analytics later.
 *
 * The product-side state machine — the one rendered to users and
 * enforced at every transition by `lib/state-machine.ts` — uses the
 * first seven values:
 *
 *   created → recording → transcribing → review → analyzing → complete
 *
 * with `deleted` reachable from any of them as the soft-delete sink.
 *
 * `uploading`, `failed`, and `expired` are infrastructure-side
 * resilience states the worker pipeline can write directly when an
 * upload stalls or a transcription job fails. They are intentionally
 * outside the user-visible state machine: a session lands there only
 * via background side-effects, never via a user click.
 */
export const interviewSessionState = pgEnum("interview_session_state", [
  "created",
  "recording",
  "uploading",
  "transcribing",
  "review",
  "analyzing",
  "complete",
  "deleted",
  "failed",
  "expired",
]);

export const interviewRoundType = pgEnum("interview_round_type", [
  "coding",
  "system_design",
  "behavioral",
  "other",
]);

/**
 * `level` is intentionally a free-text column (per spec) so the product can
 * add tiers without a migration. Validity is enforced at the API edge by
 * the Zod enum below before any insert reaches the DB.
 */
export const interviewLevels = [
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "unsure",
] as const;
export const interviewLevelSchema = z.enum(interviewLevels);
export type InterviewLevel = z.infer<typeof interviewLevelSchema>;

/**
 * Mirror Zod schemas for the Postgres enums so the API layer can reject
 * bad input with a clean validation error instead of letting it fail at
 * the driver and surface as a 500.
 */
export const interviewRoundTypeSchema = z.enum(interviewRoundType.enumValues);
export type InterviewRoundType = z.infer<typeof interviewRoundTypeSchema>;

export const interviewSessionStateSchema = z.enum(
  interviewSessionState.enumValues,
);
export type InterviewSessionState = z.infer<typeof interviewSessionStateSchema>;

export const interviewSessions = pgTable(
  "interview_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    companyName: text("company_name").notNull(),
    roleTitle: text("role_title").notNull(),

    level: text("level").notNull(),

    roundType: interviewRoundType("round_type").notNull(),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),

    state: interviewSessionState("state").notNull().default("created"),

    consentAffirmedAt: timestamp("consent_affirmed_at", { withTimezone: true })
      .notNull(),

    /**
     * Trigger date for the daily audio backstop cron. After this timestamp
     * the `enforce-session-retention` job will attempt to clean up any
     * audio_files rows still undeleted for this session (a final safety
     * net behind the 60-second SLA and the 5-minute sweeper).
     *
     * Transcripts, artifacts, and outcomes are NEVER deleted by the cron —
     * they live until the user deletes their account.
     */
    retentionUntil: timestamp("retention_until", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Dashboard "my recent interviews" query — newest-first, hides soft-deleted.
    index("interview_sessions_user_created_idx")
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.deletedAt} IS NULL`),

    // Retention sweeper picks rows whose `retention_until` has passed.
    index("interview_sessions_retention_idx")
      .on(table.retentionUntil)
      .where(sql`${table.deletedAt} IS NULL`),

    // Admin Ops dashboard: sessions-by-state-by-day reads
    // (today complete count, 24-hour analysis-failure rate,
    // 30-day sessions trend). Partial on `deleted_at IS NULL`
    // because the admin numerator and denominator both ignore
    // soft-deleted sessions.
    index("interview_sessions_state_created_idx")
      .on(table.state, table.createdAt)
      .where(sql`${table.deletedAt} IS NULL`),

    // `level` is `text` (per spec, so the product can add tiers
    // without a migration) but we still want the DB to reject obvious
    // garbage if the API-edge Zod check is ever bypassed. Keep this
    // list in sync with `interviewLevels` in this file.
    check(
      "interview_sessions_level_valid",
      sql`${table.level} IN ('junior', 'mid', 'senior', 'staff', 'principal', 'unsure')`,
    ),
  ],
);

/**
 * Transcript is a 1:1 with an interview session. Three text columns
 * because the product distinguishes:
 *   - raw_text: verbatim from STT, never displayed.
 *   - redacted_text: after PII scrubbing; this is what we surface by default.
 *   - edited_text: candidate's manual edits (optional override).
 */
export const transcripts = pgTable("transcripts", {
  id: uuid("id").primaryKey().defaultRandom(),

  sessionId: uuid("session_id")
    .notNull()
    .unique()
    .references(() => interviewSessions.id, { onDelete: "cascade" }),

  rawText: text("raw_text").notNull(),
  redactedText: text("redacted_text").notNull(),
  editedText: text("edited_text"),

  redactionCount: integer("redaction_count").notNull().default(0),
  language: text("language").notNull().default("en"),
  wordCount: integer("word_count").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  fillerWordCount: integer("filler_word_count").notNull(),

  /**
   * Set when the transcription service (or our orchestration around it) failed and we
   * still wrote the `transcripts` row to unblock the candidate. The
   * UI shows a friendly banner when this is non-null and the rest of
   * the review/augment flow remains operable on whatever empty/best-
   * effort transcript we landed in `raw_text`/`redacted_text`.
   *
   * Spec: "ALWAYS schedule audio deletion regardless of transcription
   * success" — we still drop the recording on schedule even when we
   * can't transcribe it. The error string captured here is the only
   * forensic trace once the audio is gone.
   */
  transcriptionError: text("transcription_error"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The Postgres enum is a UNION of every artifact type we've ever
 * shipped, including the legacy values from the v0 schema
 * (`whiteboard_image`, `diagram`, `notes`, `link`). The product UI
 * only emits the five values listed in `ACTIVE_ARTIFACT_TYPES` and
 * the API validates against that narrower allowlist, but Postgres
 * enums can't have values dropped without a destructive type rewrite,
 * so the legacy values stay in the DB column type forever.
 *
 * Read paths must accept any of these (rows from the v0 schema may
 * still be in the wild); write paths go through `activeArtifactTypeSchema`.
 */
export const artifactType = pgEnum("artifact_type", [
  "code",
  "whiteboard_image",
  "diagram",
  "notes",
  "link",
  "question",
  "design_text",
  "design_image",
  "other_note",
]);

/**
 * Provenance for a row in `artifacts`. Drives the post-recording
 * review flow — the candidate sees AI-inferred questions inline
 * above the relevant answer chunk and can confirm, edit, or dismiss
 * each one before analysis runs.
 *
 *   - user_added  — typed/uploaded by the candidate themselves
 *                   (the only legal value for `code`, `design_text`,
 *                   `design_image`, `other_note`).
 *   - ai_inferred — written by the transcribe-session worker after
 *                   running a Haiku inference pass over the
 *                   candidate-only transcript. Always paired with
 *                   `ai_confidence` and the `linked_transcript_*`
 *                   pointers so the UI can position the inference
 *                   card next to the answer chunk it refers to.
 */
export const artifactSource = pgEnum("artifact_source", [
  "user_added",
  "ai_inferred",
]);

export const artifactSourceSchema = z.enum(artifactSource.enumValues);
export type ArtifactSource = z.infer<typeof artifactSourceSchema>;

/**
 * Confidence band attached to AI-inferred questions only. Surfacing
 * "low" guesses to the user pushes them toward phantom-memory
 * contamination ("oh yeah, the interviewer DID ask that, didn't
 * they?") so the review UI ONLY renders `high` cards. Medium and low
 * are written to the DB and used internally by the analysis worker
 * but are never shown as guessed questions in the review step.
 */
export const aiConfidence = pgEnum("ai_confidence", [
  "high",
  "medium",
  "low",
]);

export const aiConfidenceSchema = z.enum(aiConfidence.enumValues);
export type AiConfidence = z.infer<typeof aiConfidenceSchema>;

/**
 * Full DB-side schema. Use this for read paths that need to render
 * historical rows (a row inserted before this migration may still
 * carry one of the legacy values).
 */
export const artifactTypeSchema = z.enum(artifactType.enumValues);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

/**
 * Subset the `/augment` UI emits and the artifact API will accept.
 * Anything not in this set comes back as a 400 from the create/update
 * routes — it's how we keep the legacy enum values from leaking back
 * into newly-written rows.
 *
 *   question      — "Questions you were asked" (free text)
 *   code          — "Code you wrote" (rendered monospace)
 *   design_text   — "System design notes" textual segment
 *   design_image  — "System design notes" image upload (storage key
 *                   stored in `image_url`; not auto-deleted)
 *   other_note    — "Other notes" catch-all
 */
export const ACTIVE_ARTIFACT_TYPES = [
  "question",
  "code",
  "design_text",
  "design_image",
  "other_note",
] as const;
export const activeArtifactTypeSchema = z.enum(ACTIVE_ARTIFACT_TYPES);
export type ActiveArtifactType = z.infer<typeof activeArtifactTypeSchema>;

/**
 * Misc media attached to an interview (code snippets, photos of a
 * whiteboard, etc.). `display_order` lets the UI render them in the order
 * the candidate dropped them in.
 *
 * Provenance and review-state columns:
 *   - `source`: who wrote the row (`user_added` | `ai_inferred`).
 *   - `aiConfidence`: only set for `ai_inferred` rows. Drives whether
 *     the review UI surfaces the inference (high) or hides it from
 *     the candidate but still hands it to the analyzer (medium/low).
 *   - `linkedTranscriptOffset` / `linkedTranscriptLength`: byte offsets
 *     into `transcripts.redacted_text` of the answer chunk this
 *     inferred question refers to. Lets the review screen position
 *     each card next to the right span.
 *   - `userConfirmedAt`: set when the candidate confirms an AI-inferred
 *     row (or edits its content — editing also implies confirmation
 *     since they're now the author of record).
 *   - `dismissedAt`: set when the candidate marks an inference as
 *     "wasn't asked". Soft-delete style so they can restore it later
 *     from the augment screen.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),

    artifactType: artifactType("artifact_type").notNull(),
    content: text("content"),
    imageUrl: text("image_url"),

    displayOrder: integer("display_order").notNull().default(0),

    source: artifactSource("source").notNull().default("user_added"),

    aiConfidence: aiConfidence("ai_confidence"),

    linkedTranscriptOffset: integer("linked_transcript_offset"),
    linkedTranscriptLength: integer("linked_transcript_length"),

    userConfirmedAt: timestamp("user_confirmed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("artifacts_session_order_idx").on(
      table.sessionId,
      table.displayOrder,
    ),
    // The augment screen splits its "Questions" section into three
    // groupings — confirmed, suggested (ai_inferred not yet acted on),
    // dismissed. This partial index makes each grouping cheap to
    // filter without a sequential scan once a session has many
    // inferred rows.
    index("artifacts_session_source_idx").on(table.sessionId, table.source),
    // Defense-in-depth: AI-inferred rows MUST carry their confidence
    // band, and user-added rows MUST NOT. The application enforces
    // this on the write paths but the check stops a future migration
    // / hand-fix from leaving the column shape inconsistent.
    check(
      "artifacts_source_confidence_consistent",
      sql`(${table.source} = 'ai_inferred' AND ${table.aiConfidence} IS NOT NULL)
          OR (${table.source} = 'user_added' AND ${table.aiConfidence} IS NULL)`,
    ),
  ],
);

/**
 * The AI-generated feedback report. JSONB so the rubric can evolve
 * without a migration; `rubric_version` lets us re-render historic reports
 * with their original rubric and `model_version` lets us reproduce a
 * generation if a customer disputes a score.
 *
 * One row per analysis run — re-analyses APPEND a new row rather than
 * overwriting. The user paid for each run, so each run is preserved
 * for the lifetime of the session (cascades on session delete). The
 * "current" report is the most-recent row by `created_at`; the
 * session detail page lists every earlier row in a "Previous analyses"
 * sidebar panel so the user can navigate back to ANY prior analysis,
 * not just the immediately-previous one. There is no unique constraint
 * on `session_id` for this reason; reads use the `(session_id,
 * created_at DESC)` index, which serves both the LIMIT 1 latest fetch
 * and the full ORDER BY DESC enumeration in O(log n + k).
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sessionId: uuid("session_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),

    reportJson: jsonb("report_json").notNull(),
    modelVersion: text("model_version").notNull(),
    rubricVersion: text("rubric_version").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Powers the session detail page's report fetch (full history,
    // ORDER BY created_at DESC) and the LIMIT 1 latest-only fetches
    // elsewhere. The DESC direction is encoded in the index so the
    // page's enumeration of all priors is a single index range scan.
    index("reports_session_created_idx").on(
      table.sessionId,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * Pointer to the actual recording in object storage. Kept separate from
 * the session so we can hard-delete the audio (regulatory / retention)
 * while keeping the analyzed report row indefinitely.
 *
 * `bigint` size column so the schema can hold multi-GB recordings without
 * truncation; mode 'number' since interview files realistically stay
 * under 2^53 bytes (~9 PB).
 */
export const audioFiles = pgTable(
  "audio_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sessionId: uuid("session_id")
      .notNull()
      .unique()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),

    s3Key: text("s3_key").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),

    transcriptionStartedAt: timestamp("transcription_started_at", {
      withTimezone: true,
    }),
    transcriptionCompletedAt: timestamp("transcription_completed_at", {
      withTimezone: true,
    }),

    scheduledDeletionAt: timestamp("scheduled_deletion_at", {
      withTimezone: true,
    }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audio_files_scheduled_deletion_idx")
      .on(table.scheduledDeletionAt)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export type InterviewSession = typeof interviewSessions.$inferSelect;
export type NewInterviewSession = typeof interviewSessions.$inferInsert;
export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type AudioFile = typeof audioFiles.$inferSelect;
export type NewAudioFile = typeof audioFiles.$inferInsert;
