import { execFile } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Captures a JPEG screenshot of the full screen and returns it as base64.
 * macOS only (uses the built-in screencapture utility).
 * Returns null on any failure so callers can degrade gracefully.
 */
export async function captureScreen(): Promise<string | null> {
  if (process.platform !== "darwin") return null;

  const outPath = path.join(tmpdir(), `synaptic-snap-${Date.now()}.jpg`);

  return new Promise((resolve) => {
    // -x = silent (no camera shutter), -t jpg = JPEG output
    execFile("screencapture", ["-x", "-t", "jpg", outPath], (err) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        const buf = readFileSync(outPath);
        unlinkSync(outPath);
        resolve(buf.toString("base64"));
      } catch {
        resolve(null);
      }
    });
  });
}
