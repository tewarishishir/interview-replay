import "server-only";
import fs from "fs/promises";
import path from "path";
import { getStoragePath } from "./index";

export async function deleteFile(key: string): Promise<void> {
  const fullPath = path.join(getStoragePath(), key);
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
