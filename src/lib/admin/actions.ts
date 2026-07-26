"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/lib/db";
import { ADMIN_AUDIT_EVENTS, recordAdminAction } from "@/lib/admin/audit";
import { getAdminUser } from "@/lib/admin/auth";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";

/**
 * Server actions for the `/admin/users/[id]` detail page.
 *
 * Every action here:
 *   1. Re-checks `is_admin = true` via `getAdminUser()`. The
 *      (admin)/layout's gate is for the GET render; a POST action
 *      lives outside that render tree, so the gate has to be
 *      re-applied — relying on the layout would be a CSRF /
 *      forgotten-gate trap.
 *
 *   2. Runs the state change + the `admin_action.*` audit row
 *      inside ONE `db.transaction(...)`, so a failed audit insert
 *      rolls back the action. The audit log MUST be append-only
 *      and consistent with the state.
 *
 *   3. Calls `revalidatePath` on the detail page so the new state
 *      (new note, etc.) shows up on the next render without a
 *      full reload.
 *
 *   4. Fires `admin_action_taken` analytics event for the
 *      operator's own usage tracking. The payload carries
 *      action_type + target_user_id only — no PII, no free-text
 *      reason.
 *
 * Errors return a tagged `{ ok: false, error }` discriminated
 * union so the calling Client Component can render an inline
 * banner instead of relying on thrown errors propagating up
 * (which Next 15 turns into an opaque "An error occurred"
 * splash).
 */

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ─── Notes ─────────────────────────────────────────────────────────

const createNoteSchema = z.object({
  userId: z.string().uuid(),
  note: z
    .string()
    .trim()
    .min(1, "Note can't be empty.")
    .max(2000, "Notes are capped at 2000 characters."),
});

export async function createNoteAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: "not_authorized" };

  const parsed = createNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_input" };
  }
  const { userId, note } = parsed.data;

  try {
    const id = await db.transaction(async (tx) => {
      const [exists] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
        .limit(1);
      if (!exists) throw new Error("user_not_found");

      const [row] = await tx
        .insert(schema.adminNotes)
        .values({
          userId,
          adminId: admin.id,
          note,
        })
        .returning({ id: schema.adminNotes.id });

      await recordAdminAction({
        adminId: admin.id,
        action: ADMIN_AUDIT_EVENTS.actionNoteCreated,
        targetUserId: userId,
        // The note text itself is intentionally NOT inlined into
        // the audit payload — it lives in `admin_notes`, which is
        // the system of record. The audit row carries just the
        // note id so the forensic trail can join back.
        details: { note_id: row!.id },
      });

      return row!.id;
    });

    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminActionTaken,
      properties: {
        action_type: "note_created",
        target_user_id: userId,
      },
    });

    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, data: { id } };
  } catch (err) {
    if (err instanceof Error && err.message === "user_not_found") {
      return { ok: false, error: "user_not_found" };
    }
    console.error("[admin/actions] createNote failed:", err);
    return { ok: false, error: "internal_error" };
  }
}

const deleteNoteSchema = z.object({
  noteId: z.string().uuid(),
});

export async function deleteNoteAction(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: "not_authorized" };

  const parsed = deleteNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_input" };
  }
  const { noteId } = parsed.data;

  try {
    const userIdToRevalidate = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: schema.adminNotes.id, userId: schema.adminNotes.userId })
        .from(schema.adminNotes)
        .where(eq(schema.adminNotes.id, noteId))
        .limit(1);
      if (!row) throw new Error("note_not_found");

      await tx.delete(schema.adminNotes).where(eq(schema.adminNotes.id, noteId));

      await recordAdminAction({
        adminId: admin.id,
        action: ADMIN_AUDIT_EVENTS.actionNoteDeleted,
        targetUserId: row.userId,
        details: { note_id: noteId },
      });

      return row.userId;
    });

    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminActionTaken,
      properties: {
        action_type: "note_deleted",
        target_user_id: userIdToRevalidate,
      },
    });

    revalidatePath(`/admin/users/${userIdToRevalidate}`);
    return { ok: true, data: undefined };
  } catch (err) {
    if (err instanceof Error && err.message === "note_not_found") {
      return { ok: false, error: "note_not_found" };
    }
    console.error("[admin/actions] deleteNote failed:", err);
    return { ok: false, error: "internal_error" };
  }
}

