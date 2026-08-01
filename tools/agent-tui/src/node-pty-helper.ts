import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function ensureNodePtyHelper(): Promise<void> {
  if (process.platform === "win32") return;

  const candidates = [
    resolve(TOOL_ROOT, `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`),
    resolve(TOOL_ROOT, "node_modules/node-pty/build/Release/spawn-helper"),
  ];
  for (const candidate of candidates) {
    try {
      await chmod(candidate, 0o755);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
