import "server-only";
import fs from "fs/promises";
import path from "path";
import { getStoragePath } from "./index";

export async function writeFile(key: string, data: Buffer | Uint8Array): Promise<void> {
  const fullPath = path.join(getStoragePath(), key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, data);
}
