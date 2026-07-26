import { NextResponse } from "next/server";

import { createNoteAction } from "@/lib/admin/actions";

/**
 * POST /api/admin/users/[id]/notes
 *
 * Body: `{ note: string }`
 *
 * Creates an admin note attached to the target user. Mirrors the
 * detail-page UI's "Add note" form.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const payload =
    typeof body === "object" && body !== null
      ? { ...(body as Record<string, unknown>), userId: id }
      : { userId: id };

  const result = await createNoteAction(payload);
  if (!result.ok) {
    if (result.error === "not_authorized") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (result.error === "user_not_found") {
      return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result.data, { status: 201 });
}
