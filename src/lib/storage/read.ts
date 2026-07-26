import "server-only";
import fs from "fs/promises";
import path from "path";
import { getStoragePath } from "./index";

export async function readFile(key: string): Promise<Buffer> {
  const fullPath = path.join(getStoragePath(), key);
  return fs.readFile(fullPath);
}

export async function readFileStream(key: string): Promise<ReadableStream> {
  const { createReadStream } = await import("fs");
  const fullPath = path.join(getStoragePath(), key);
  const nodeStream = createReadStream(fullPath);
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}
