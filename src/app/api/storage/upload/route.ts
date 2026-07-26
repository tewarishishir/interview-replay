import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { writeFile } from "@/lib/storage/write";
import {
  audioKey,
  resumeKey,
  artifactKey,
  MAX_AUDIO_SIZE_BYTES,
  MAX_RESUME_SIZE_BYTES,
  MAX_ARTIFACT_SIZE_BYTES,
} from "@/lib/storage/keys";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const type = formData.get("type") as string;
  const sessionId = formData.get("sessionId") as string | null;
  const ext = formData.get("ext") as string | null;

  if (!file || !type) {
    return NextResponse.json({ error: "Missing file or type" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let key: string;
  let maxSize: number;

  switch (type) {
    case "audio":
      if (!sessionId) return NextResponse.json({ error: "sessionId required for audio" }, { status: 400 });
      key = audioKey(session.user.id, sessionId);
      maxSize = MAX_AUDIO_SIZE_BYTES;
      break;
    case "resume":
      key = resumeKey(session.user.id);
      maxSize = MAX_RESUME_SIZE_BYTES;
      break;
    case "artifact":
      if (!sessionId || !ext) return NextResponse.json({ error: "sessionId and ext required for artifact" }, { status: 400 });
      key = artifactKey(session.user.id, sessionId, ext);
      maxSize = MAX_ARTIFACT_SIZE_BYTES;
      break;
    default:
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  if (buffer.length > maxSize) {
    return NextResponse.json({ error: `File too large (max ${maxSize} bytes)` }, { status: 413 });
  }

  await writeFile(key, buffer);
  return NextResponse.json({ key });
}
