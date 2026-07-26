import { headers as nextHeaders } from "next/headers";
import { NextResponse } from "next/server";

import { cspReportLimiter, ipFromHeaders } from "@/lib/rate-limit";

/**
 * POST /api/csp-report
 *
 * Sink for browser CSP violation reports while the policy is in
 * `Content-Security-Policy-Report-Only` mode.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  const h = await nextHeaders();
  const ip = ipFromHeaders(h) ?? "unknown";
  const limit = await cspReportLimiter().check(ip);
  if (!limit.success) {
    return new NextResponse(null, { status: 204 });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204 });
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (bodyText.length === 0 || bodyText.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204 });
  }

  let report: unknown;
  try {
    report = JSON.parse(bodyText);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  try {
    const cspReport =
      typeof report === "object" && report !== null
        ? (report as Record<string, unknown>)["csp-report"] ?? report
        : report;
    console.warn("[csp-report] violation:", cspReport);
  } catch (err) {
    console.warn("[csp-report] logging failed:", err);
  }

  return new NextResponse(null, { status: 204 });
}
