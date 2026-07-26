import { NextResponse } from "next/server";

import { getAdminUser } from "@/lib/admin/auth";
import { getUserDetail } from "@/lib/admin/users-queries";

/**
 * GET /api/admin/users/[id]
 *
 * Returns the full detail object for one user. Same gate /
 * disclosure pattern as the other admin endpoints.
 *
 * Returns 404 (not 403) for missing/soft-deleted users — a real
 * 403 would let an attacker enumerate valid user ids by status.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await getAdminUser();
  if (!admin) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { id } = await params;
  const detail = await getUserDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(detail, { status: 200 });
}
