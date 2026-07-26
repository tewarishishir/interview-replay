import { NextRequest, NextResponse } from "next/server";
import { verifyFileToken } from "@/lib/storage/signed-url";
import { readFile } from "@/lib/storage/read";
import { fileExists } from "@/lib/storage/exists";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".webm": "audio/webm",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }

  const result = verifyFileToken(token);
  if (!result.valid || !result.key) {
    return NextResponse.json({ error: result.error || "Invalid token" }, { status: 403 });
  }

  const meta = await fileExists(result.key);
  if (!meta.exists) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const data = await readFile(result.key);
  const ext = path.extname(result.key).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
