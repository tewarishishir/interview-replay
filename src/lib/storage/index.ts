import "server-only";
import { env, features } from "@/lib/env";
import path from "path";

export class StorageNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = "storage_unavailable";
  constructor() {
    super("Local storage is not configured. Set STORAGE_PATH in your environment.");
    this.name = "StorageNotConfiguredError";
  }
}

export function getStoragePath(): string {
  if (!features.audioStorage) throw new StorageNotConfiguredError();
  return env.STORAGE_PATH || path.join(process.cwd(), "data", "uploads");
}

export function getStorageSecret(): string {
  const secret = env.STORAGE_SECRET;
  if (!secret) throw new Error("STORAGE_SECRET is required for signed file URLs");
  return secret;
}
