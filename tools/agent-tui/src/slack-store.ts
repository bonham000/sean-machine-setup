import { readFile, rename, writeFile } from "node:fs/promises";
import { ensureDirectories, sessionSlackPath } from "./paths.ts";
import type { SlackBinding } from "./types.ts";

export async function readSlackBinding(sessionId: string): Promise<SlackBinding> {
  return JSON.parse(await readFile(sessionSlackPath(sessionId), "utf8")) as SlackBinding;
}

export async function writeSlackBinding(binding: SlackBinding): Promise<void> {
  await ensureDirectories();
  const destination = sessionSlackPath(binding.sessionId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}
