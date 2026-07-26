import crypto from "crypto";
import path from "path";
import { getStoragePath } from "./index";

export function audioKey(userId: string, sessionId: string): string {
  const uuid = crypto.randomUUID();
  return `audio/${userId}/${sessionId}/${uuid}.webm`;
}

export function audioPath(key: string): string {
  return path.join(getStoragePath(), key);
}

export function resumeKey(userId: string): string {
  const uuid = crypto.randomUUID();
  return `resumes/${userId}/${uuid}.pdf`;
}

export function resumePath(key: string): string {
  return path.join(getStoragePath(), key);
}

const ALLOWED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

export function artifactKey(userId: string, sessionId: string, ext: string): string {
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext.toLowerCase() as any)) {
    throw new Error(`Invalid artifact extension: ${ext}`);
  }
  const uuid = crypto.randomUUID();
  return `artifacts/${userId}/${sessionId}/${uuid}.${ext.toLowerCase()}`;
}

export function artifactPath(key: string): string {
  return path.join(getStoragePath(), key);
}

export const MAX_AUDIO_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_RESUME_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_ARTIFACT_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
