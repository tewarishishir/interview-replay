import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { deleteNoteAction } from "@/lib/admin/actions";
import { isSameOrigin } from "@/lib/same-origin";

/**
 * DELETE /api/admin/notes/[noteId]
 *
 * Removes an admin note. Mirrors the detail-page delete button.
 * Records an `admin_action.note_deleted` audit row carrying the
 * note id, which preserves a forensic trail even after the row
 * is gone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ noteId: string }> },
): Promise<Response> {
  const h = await headers();
  if (!isSameOrigin(h)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { noteId } = await params;
  const result = await deleteNoteAction({ noteId });
  if (!result.ok) {
    if (result.error === "not_authorized") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (result.error === "note_not_found") {
      return NextResponse.json({ error: "note_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
