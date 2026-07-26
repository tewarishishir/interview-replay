import "server-only";
import fs from "fs/promises";
import path from "path";
import { getStoragePath } from "./index";

export interface FileMetadata {
  exists: boolean;
  size?: number;
  lastModified?: Date;
}

export async function fileExists(key: string): Promise<FileMetadata> {
  const fullPath = path.join(getStoragePath(), key);
  try {
    const stat = await fs.stat(fullPath);
    return { exists: true, size: stat.size, lastModified: stat.mtime };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}
