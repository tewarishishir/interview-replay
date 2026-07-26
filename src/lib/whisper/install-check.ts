import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WhisperInstallStatus {
  installed: boolean;
  version?: string;
  error?: string;
}

/**
 * Verifies that `faster_whisper` is importable by the system Python
 * interpreter. Returns the installed version on success, or a
 * diagnostic error string on failure.
 */
export async function checkWhisperInstallation(): Promise<WhisperInstallStatus> {
  try {
    const { stdout } = await execFileAsync("python3", [
      "-c",
      "import faster_whisper; print(faster_whisper.__version__)",
    ]);
    return { installed: true, version: stdout.trim() };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
