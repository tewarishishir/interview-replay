import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import {
  ACTIVE_ARTIFACT_TYPES,
  type ActiveArtifactType,
  activeArtifactTypeSchema,
  type Artifact,
  type InterviewSessionState,
} from "@/lib/db/schema";

/**
 * Server-side helpers for the artifact CRUD on the augment screen.
 *
 * The route handlers do auth/ownership/state-guard checks first;
 * these helpers trust their arguments and just write the row +
 * audit log inside one transaction.
 *
 * Spec rules enforced here:
 *   - Validation per `artifact_type`: `design_image` requires
 *     `image_url`; the other types require non-empty `content`.
 *   - The session must be in `review`, `analyzing`, or `complete`
 *     when the artifact is created or modified. The state guard is
 *     done at the route layer (with a clean 409 + currentState in
 *     the body); this module just trusts the caller.
 */

export const ARTIFACT_WRITE_ALLOWED_STATES: readonly InterviewSessionState[] = [
  "review",
  "analyzing",
  "complete",
] as const;

/**
 * Body shape for `POST /api/sessions/:id/artifacts`.
 *
 * Per-type rules (enforced in the `superRefine` below):
 *   - `design_image` MUST carry `image_url`. It MAY carry `content`
 *     — when present, `content` is treated as the original
 *     candidate-uploaded filename (e.g. "system-architecture.png")
 *     and is rendered next to the image on the augment screen.
 *     We cap it tighter than the generic 50 KB body since real
 *     filenames are well under 512 bytes.
 *   - All other types MUST carry non-empty `content` and MUST NOT
 *     carry `image_url`.
 */
export const createArtifactBodySchema = z
  .object({
    artifact_type: activeArtifactTypeSchema,
    content: z.string().trim().max(50_000).optional(),
    image_url: z.string().trim().max(2_048).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.artifact_type === "design_image") {
      if (!value.image_url) {
        ctx.addIssue({
          code: "custom",
          path: ["image_url"],
          message: "image_url is required for design_image artifacts.",
        });
      }
      if (value.content !== undefined && value.content.length > 512) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "filename is too long (max 512 characters).",
        });
      }
    } else {
      if (!value.content || value.content.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["content"],
          message: "content is required for this artifact type.",
        });
      }
      if (value.image_url) {
        ctx.addIssue({
          code: "custom",
          path: ["image_url"],
          message: "image_url is only allowed for design_image artifacts.",
        });
      }
    }
  });

export type CreateArtifactBody = z.infer<typeof createArtifactBodySchema>;

/**
 * `PATCH` body. We deliberately don't allow changing the artifact_type
 * after creation — the validation rules in `createArtifactBodySchema`
 * couple type to (content vs. image_url), so a type change would
 * require also re-validating the other fields. Callers can delete
 * and re-create instead.
 */
export const updateArtifactBodySchema = z
  .object({
    content: z.string().trim().max(50_000).optional(),
    image_url: z.string().trim().max(2_048).optional(),
  })
  .refine((v) => v.content !== undefined || v.image_url !== undefined, {
    message: "Provide content or image_url to update.",
  });

export type UpdateArtifactBody = z.infer<typeof updateArtifactBodySchema>;

/**
 * Insert an artifact + audit log row in one transaction. Returns the
 * inserted row.
 *
 * Newly-created rows from this path always carry `source = 'user_added'`
 * (the column default). The AI-inferred path goes through
 * `persistTranscriptAndAdvance` in `lib/sessions/transcribe.ts` —
 * the augment-screen API never mints `ai_inferred` rows.
 */
export async function createArtifact(args: {
  sessionId: string;
  userId: string;
  body: CreateArtifactBody;
}): Promise<Artifact> {
  return db.transaction(async (tx) => {
    // `display_order` defaults to "max(existing)+1" so newly-added
    // artifacts always render at the bottom. Done as a single
    // SELECT-FOR-UPDATE-style query but with a plain SELECT; the
    // worst case if two adds race is a tied ordering, which the
    // `(display_order, created_at)` index breaks deterministically.
    const existing = await tx
      .select({ displayOrder: schema.artifacts.displayOrder })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.sessionId, args.sessionId));
    const nextOrder = existing.reduce(
      (acc, r) => Math.max(acc, r.displayOrder + 1),
      0,
    );

    const [row] = await tx
      .insert(schema.artifacts)
      .values({
        sessionId: args.sessionId,
        artifactType: args.body.artifact_type,
        content: args.body.content ?? null,
        imageUrl: args.body.image_url ?? null,
        displayOrder: nextOrder,
        // Defense in depth: the column default is `'user_added'`, but
        // we set it explicitly so a future column-rename can't silently
        // change provenance for new user-typed artifacts.
        source: "user_added",
      })
      .returning();
    if (!row) {
      throw new Error(
        `createArtifact: artifacts INSERT returned no row for session ${args.sessionId}`,
      );
    }

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.artifact.created",
      eventData: {
        sessionId: args.sessionId,
        artifactId: row.id,
        artifactType: row.artifactType,
        source: row.source,
        hasContent: row.content !== null,
        hasImageUrl: row.imageUrl !== null,
      },
    });

    return row;
  });
}

/**
 * Update an existing artifact. Caller has already loaded the row to
 * confirm ownership; we re-pin the WHERE on (id, sessionId) for
 * defense-in-depth.
 *
 * AI-inferred → user-confirmed promotion:
 *   When the candidate edits the content of an `ai_inferred` row, the
 *   spec says the row "promotes to user-confirmed" — we record that
 *   by stamping `user_confirmed_at = now()` AND clearing
 *   `ai_confidence`. The check constraint is satisfied because the
 *   row is also flipped to `source = 'user_added'`. After the edit,
 *   the row is indistinguishable from one the candidate typed in
 *   the augment screen, except that its `linked_transcript_*`
 *   pointers (if any) are preserved — useful for the analyze pass.
 *
 *   We do NOT clear the linked transcript pointers on edit. Even an
 *   edited inference still refers to a specific span of audio.
 */
export async function updateArtifact(args: {
  artifactId: string;
  sessionId: string;
  userId: string;
  body: UpdateArtifactBody;
  /**
   * Existing artifact_type. We need it to enforce the same content-
   * vs-image_url rules `createArtifactBodySchema` applies — a
   * `design_image` row can never gain `content` and a non-image
   * row can never gain `image_url`.
   */
  currentType: ActiveArtifactType;
  /**
   * Existing `source`. When this is `ai_inferred` and the body
   * changes `content`, we apply the promotion-on-edit semantics
   * described above.
   */
  currentSource?: "user_added" | "ai_inferred";
}): Promise<Artifact | null> {
  // Type-aware partial updates. We only touch the fields that are
  // valid for this artifact's type.
  const set: {
    content?: string;
    imageUrl?: string;
    source?: "user_added" | "ai_inferred";
    aiConfidence?: null;
    userConfirmedAt?: Date;
    dismissedAt?: null;
  } = {};
  if (args.currentType === "design_image") {
    // `content` on a design_image is the original filename (used
    // for display only). Allow updating it independently of the URL
    // so a candidate can rename a "Screen Shot 2024-…" upload to
    // something meaningful without re-uploading.
    if (args.body.content !== undefined) {
      if (args.body.content.length > 512) {
        throw new Error("filename is too long (max 512 characters).");
      }
      set.content = args.body.content;
    }
    if (args.body.image_url !== undefined) {
      set.imageUrl = args.body.image_url;
    }
  } else {
    if (args.body.image_url !== undefined) {
      throw new Error(
        "Cannot set image_url on a non-image artifact.",
      );
    }
    if (args.body.content !== undefined) {
      set.content = args.body.content;
    }
  }

  // Promotion on edit. Only fires when:
  //   - the row was AI-inferred (caller passed currentSource), AND
  //   - the candidate is actually changing the content (a no-op
  //     update to image_url on a non-image row is impossible per
  //     the type guard above; image edits aren't applicable to
  //     ai_inferred rows since those are always 'question' type).
  if (
    args.currentSource === "ai_inferred" &&
    set.content !== undefined &&
    args.currentType !== "design_image"
  ) {
    set.source = "user_added";
    set.aiConfidence = null;
    set.userConfirmedAt = new Date();
    // Editing also un-dismisses — a candidate who edits a previously
    // dismissed row is implicitly restoring it.
    set.dismissedAt = null;
  }

  if (Object.keys(set).length === 0) return null;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.artifacts)
      .set(set)
      .where(
        and(
          eq(schema.artifacts.id, args.artifactId),
          eq(schema.artifacts.sessionId, args.sessionId),
        ),
      )
      .returning();
    if (!row) return null;

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType:
        args.currentSource === "ai_inferred" && set.content !== undefined
          ? "session.artifact.ai_edited"
          : "session.artifact.updated",
      eventData: {
        sessionId: args.sessionId,
        artifactId: row.id,
        artifactType: row.artifactType,
        source: row.source,
      },
    });

    return row;
  });
}

/**
 * Confirm an AI-inferred artifact. Sets `user_confirmed_at = now()`
 * but leaves `source = 'ai_inferred'` and `ai_confidence` intact
 * — the row is still a record of what the AI guessed, the candidate
 * has just acknowledged that guess as correct. The augment screen
 * surfaces these under "Confirmed" alongside `user_added` rows.
 *
 * Idempotent: re-calling on an already-confirmed row is a no-op
 * (we only update when `user_confirmed_at IS NULL`). Refuses to
 * confirm a dismissed row — the candidate has to restore it first.
 */
export async function confirmArtifact(args: {
  artifactId: string;
  sessionId: string;
  userId: string;
}): Promise<Artifact | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.artifacts)
      .set({ userConfirmedAt: new Date() })
      .where(
        and(
          eq(schema.artifacts.id, args.artifactId),
          eq(schema.artifacts.sessionId, args.sessionId),
          eq(schema.artifacts.source, "ai_inferred"),
          // Only flip when not already confirmed AND not dismissed.
          // The CTE-style WHERE keeps the operation idempotent and
          // reflects the state-machine: confirm + dismiss are
          // mutually exclusive.
          sql`${schema.artifacts.userConfirmedAt} IS NULL`,
          sql`${schema.artifacts.dismissedAt} IS NULL`,
        ),
      )
      .returning();
    if (!row) return null;

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.artifact.ai_confirmed",
      eventData: {
        sessionId: args.sessionId,
        artifactId: row.id,
        aiConfidence: row.aiConfidence,
      },
    });
    return row;
  });
}

/**
 * Dismiss an AI-inferred artifact ("wasn't asked"). Soft-delete style:
 * the row stays in the DB so the candidate can restore it later from
 * the augment screen. The analyze pass treats dismissed rows as
 * unprompted speech (the linked answer chunk is no longer associated
 * with a question).
 *
 * Idempotent: a re-dismiss on an already-dismissed row is a no-op.
 */
export async function dismissArtifact(args: {
  artifactId: string;
  sessionId: string;
  userId: string;
}): Promise<Artifact | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.artifacts)
      .set({ dismissedAt: new Date() })
      .where(
        and(
          eq(schema.artifacts.id, args.artifactId),
          eq(schema.artifacts.sessionId, args.sessionId),
          eq(schema.artifacts.source, "ai_inferred"),
          sql`${schema.artifacts.dismissedAt} IS NULL`,
        ),
      )
      .returning();
    if (!row) return null;

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.artifact.ai_dismissed",
      eventData: {
        sessionId: args.sessionId,
        artifactId: row.id,
        aiConfidence: row.aiConfidence,
      },
    });
    return row;
  });
}

/**
 * Restore a previously-dismissed AI-inferred artifact: clears
 * `dismissed_at` so the row reappears under "Suggested by AI" on
 * the augment screen.
 */
export async function restoreArtifact(args: {
  artifactId: string;
  sessionId: string;
  userId: string;
}): Promise<Artifact | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.artifacts)
      .set({ dismissedAt: null })
      .where(
        and(
          eq(schema.artifacts.id, args.artifactId),
          eq(schema.artifacts.sessionId, args.sessionId),
          eq(schema.artifacts.source, "ai_inferred"),
          sql`${schema.artifacts.dismissedAt} IS NOT NULL`,
        ),
      )
      .returning();
    if (!row) return null;

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.artifact.ai_restored",
      eventData: { sessionId: args.sessionId, artifactId: row.id },
    });
    return row;
  });
}

/**
 * Delete an artifact. Returns `true` if a row was deleted, `false`
 * if it was already gone (idempotent).
 */
export async function deleteArtifact(args: {
  artifactId: string;
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.id, args.artifactId),
          eq(schema.artifacts.sessionId, args.sessionId),
        ),
      )
      .returning({
        id: schema.artifacts.id,
        artifactType: schema.artifacts.artifactType,
      });
    if (!row) return false;

    await tx.insert(schema.auditLog).values({
      userId: args.userId,
      eventType: "session.artifact.deleted",
      eventData: {
        sessionId: args.sessionId,
        artifactId: row.id,
        artifactType: row.artifactType,
      },
    });

    return true;
  });
}

export const ACTIVE_ARTIFACT_TYPE_LIST = ACTIVE_ARTIFACT_TYPES;
