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
 *      and consistent with the state — split writes invite a
 *      "credits granted but no audit row" forensic blind spot.
 *
 *   3. Calls `revalidatePath` on the detail page so the new state
 *      (updated balance, new note, etc.) shows up on the next
 *      render without a full reload. The list page is also
 *      revalidated when the change affects table columns
 *      (credit grants change last-activity ordering).
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

// ─── Grant credits ────────────────────────────────────────────────

const grantCreditsSchema = z.object({
  userId: z.string().uuid(),
  credits: z
    .number()
    .int()
    .min(1, "Must grant at least 1 credit.")
    .max(50, "Single grants are capped at 50 credits."),
  reason: z
    .string()
    .trim()
    .min(3, "Reason is required (so the audit log is searchable).")
    .max(500),
});

export interface GrantCreditsResult {
  newBalance: number;
}

/**
 * Add credits to a user's balance.
 *
 *   - Writes the running balance to `users.credit_balance` AND
 *     a row to `credit_transactions` with reason='admin_adjustment'.
 *     The reason is the closest existing enum value (the ledger
 *     enum doesn't have `admin_grant` and adding one is a
 *     destructive type rewrite we don't need here).
 *
 *   - Logs to `audit_log` with event_type='admin_action.grant_credits'
 *     and `details: { credits, reason, balance_after }`.
 *
 *   - Refuses to grant to a soft-deleted user (their FKs are
 *     restricted; the action would fail downstream anyway).
 */
export async function grantCreditsAction(
  input: unknown,
): Promise<ActionResult<GrantCreditsResult>> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: "not_authorized" };

  const parsed = grantCreditsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_input" };
  }
  const { userId, credits, reason } = parsed.data;

  try {
    const newBalance = await db.transaction(async (tx) => {
      // Lock the user row + check existence + soft-delete state
      // in one read so a concurrent delete can't slip in between
      // the existence check and the update.
      const [target] = await tx
        .select({
          id: schema.users.id,
          balance: schema.users.creditBalance,
        })
        .from(schema.users)
        .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
        .for("update")
        .limit(1);

      if (!target) {
        throw new Error("user_not_found");
      }

      const next = target.balance + credits;

      await tx
        .update(schema.users)
        .set({ creditBalance: next, updatedAt: new Date() })
        .where(eq(schema.users.id, userId));

      await tx.insert(schema.creditTransactions).values({
        userId,
        delta: credits,
        balanceAfter: next,
        // The closest existing reason value for an operator-side
        // grant. See file-level comment for why we don't add a
        // new enum value here.
        reason: "admin_adjustment",
      });

      await recordAdminAction({
        adminId: admin.id,
        action: ADMIN_AUDIT_EVENTS.actionGrantCredits,
        targetUserId: userId,
        details: { credits, reason, balance_after: next },
      });

      return next;
    });

    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminActionTaken,
      properties: {
        action_type: "grant_credits",
        target_user_id: userId,
      },
    });

    revalidatePath(`/admin/users/${userId}`);
    revalidatePath("/admin/users");
    return { ok: true, data: { newBalance } };
  } catch (err) {
    if (err instanceof Error && err.message === "user_not_found") {
      return { ok: false, error: "user_not_found" };
    }
    console.error("[admin/actions] grantCredits failed:", err);
    return { ok: false, error: "internal_error" };
  }
}

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

// ─── Refund (audit-only) ──────────────────────────────────────────

const recordRefundIntentSchema = z.object({
  purchaseId: z.string().uuid(),
});

/**
 * Records that the admin clicked "Refund" on a payment.
 *
 * Writes an audit-log row so the forensic trail records "admin X
 * initiated refund on payment Y at T".
 */
export async function recordRefundIntentAction(
  input: unknown,
): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: "not_authorized" };

  const parsed = recordRefundIntentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_input" };
  }
  const { purchaseId } = parsed.data;

  try {
    const userId = await db.transaction(async (tx) => {
      const [purchase] = await tx
        .select({
          id: schema.creditPurchases.id,
          userId: schema.creditPurchases.userId,
          txnRef: schema.creditPurchases.txnRef,
          txnId: schema.creditPurchases.txnId,
        })
        .from(schema.creditPurchases)
        .where(eq(schema.creditPurchases.id, purchaseId))
        .limit(1);
      if (!purchase) throw new Error("purchase_not_found");
      if (!purchase.userId) throw new Error("purchase_anonymized");

      await recordAdminAction({
        adminId: admin.id,
        action: ADMIN_AUDIT_EVENTS.actionRefund,
        targetUserId: purchase.userId,
        details: {
          purchase_id: purchase.id,
          txn_ref: purchase.txnRef,
          txn_id: purchase.txnId,
        },
      });

      return purchase.userId;
    });

    trackServerEvent({
      distinctId: admin.id,
      event: ANALYTICS_EVENTS.adminActionTaken,
      properties: {
        action_type: "refund_initiated",
        target_user_id: userId,
      },
    });

    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, data: undefined };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === "purchase_not_found" || err.message === "purchase_anonymized")
    ) {
      return { ok: false, error: err.message };
    }
    console.error("[admin/actions] recordRefundIntent failed:", err);
    return { ok: false, error: "internal_error" };
  }
}
