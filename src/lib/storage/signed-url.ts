import "server-only";
import crypto from "crypto";
import { getStorageSecret } from "./index";

export function signFileToken(key: string, expiresInSeconds: number = 3600): string {
  const secret = getStorageSecret();
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${key}:${expires}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ key, expires, sig: signature })).toString("base64url");
}

export function verifyFileToken(token: string): { valid: boolean; key?: string; error?: string } {
  try {
    const secret = getStorageSecret();
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString());
    const { key, expires, sig } = decoded;

    if (Math.floor(Date.now() / 1000) > expires) {
      return { valid: false, error: "Token expired" };
    }

    const payload = `${key}:${expires}`;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return { valid: false, error: "Invalid signature" };
    }

    return { valid: true, key };
  } catch {
    return { valid: false, error: "Malformed token" };
  }
}

export function buildFileUrl(key: string, expiresInSeconds?: number): string {
  const token = signFileToken(key, expiresInSeconds);
  return `/api/storage/file?token=${token}`;
}
