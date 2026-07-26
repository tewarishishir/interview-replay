"use client";

import { useState, useTransition } from "react";

import { createNoteAction, deleteNoteAction } from "@/lib/admin/actions";
import type { UserNoteRow } from "@/lib/admin/users-queries";

interface NotesPanelProps {
  userId: string;
  notes: UserNoteRow[];
}

/**
 * Admin notes list + add-note form.
 *
 * Newest-first list rendered above the textarea so the operator
 * sees prior context before writing. Each note's delete button
 * confirms inline via a one-click toggle (no modal) — the audit
 * trail records every delete so an accidental click is recoverable
 * through the audit log, and the modal friction outweighs the
 * benefit for a low-blast-radius action.
 *
 * Local state mirrors the server list so the new note appears
 * immediately on submit without waiting for the page revalidation
 * to round-trip. On submit failure, the optimistic row is
 * reverted and an error string surfaced.
 */
export function NotesPanel({ userId, notes: initialNotes }: NotesPanelProps) {
  const [notes, setNotes] = useState(initialNotes);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const form = e.currentTarget;
          const text = (
            form.elements.namedItem("note") as HTMLTextAreaElement
          ).value.trim();
          if (!text) return;

          startTransition(async () => {
            const result = await createNoteAction({ userId, note: text });
            if (result.ok) {
              form.reset();
              // The page revalidates server-side, but we also
              // optimistically push the row in so the panel
              // updates without waiting for the round-trip.
              setNotes((prev) => [
                {
                  id: result.data.id,
                  note: text,
                  adminEmail: "you",
                  adminName: null,
                  createdAt: new Date(),
                },
                ...prev,
              ]);
            } else {
              setError(result.error);
            }
          });
        }}
      >
        <textarea
          name="note"
          rows={3}
          maxLength={2000}
          required
          placeholder="Add a note about this user (visible to admins only)"
          className="rounded-md border px-3 py-2 text-sm"
          style={{
            background: "var(--color-bg-primary)",
            borderColor: "var(--color-border-secondary)",
            color: "var(--color-text-primary)",
          }}
        />
        <div className="flex items-center justify-between text-xs">
          {error ? (
            <span style={{ color: "var(--color-danger-text)" }}>
              Failed: {error}
            </span>
          ) : (
            <span style={{ color: "var(--color-text-tertiary)" }}>
              Notes are visible only to admins. Audit logged.
            </span>
          )}
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border px-3 py-1 text-sm disabled:opacity-50"
            style={{
              background: "var(--color-bg-tertiary)",
              borderColor: "var(--color-border-secondary)",
              color: "var(--color-text-primary)",
            }}
          >
            {pending ? "Saving…" : "Add note"}
          </button>
        </div>
      </form>

      <ul className="mt-4 flex flex-col gap-2">
        {notes.length === 0 && (
          <li
            className="text-xs italic"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            No notes yet.
          </li>
        )}
        {notes.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            onDelete={() => {
              startTransition(async () => {
                const result = await deleteNoteAction({ noteId: n.id });
                if (result.ok) {
                  setNotes((prev) => prev.filter((p) => p.id !== n.id));
                } else {
                  setError(result.error);
                }
              });
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function NoteCard({
  note,
  onDelete,
}: {
  note: UserNoteRow;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li
      className="rounded-md p-3 text-sm"
      style={{
        background: "var(--color-bg-secondary)",
        borderRadius: "var(--border-radius-md, 8px)",
      }}
    >
      <div
        className="whitespace-pre-wrap"
        style={{ color: "var(--color-text-primary)" }}
      >
        {note.note}
      </div>
      <div
        className="mt-2 flex items-center justify-between text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <span>
          {note.adminName?.trim() || note.adminEmail} ·{" "}
          {note.createdAt.toLocaleString()}
        </span>
        {confirming ? (
          <span className="flex items-center gap-2">
            <span style={{ color: "var(--color-danger-text)" }}>Delete?</span>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md px-2 py-0.5 text-xs"
              style={{
                background: "var(--color-danger)",
                color: "white",
              }}
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-0.5 text-xs"
              style={{
                background: "var(--color-bg-tertiary)",
                color: "var(--color-text-primary)",
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-xs hover:underline"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}
