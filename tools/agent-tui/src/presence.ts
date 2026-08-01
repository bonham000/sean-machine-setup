import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { sessionAttachedPath } from "./paths.ts";

export function markTerminalAttached(sessionId: string): void {
  writeFileSync(sessionAttachedPath(sessionId), `${process.pid}\n`, { mode: 0o600 });
}

export function clearTerminalAttached(sessionId: string): void {
  try {
    unlinkSync(sessionAttachedPath(sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function isTerminalAttached(sessionId: string): boolean {
  try {
    const ownerPid = Number(readFileSync(sessionAttachedPath(sessionId), "utf8").trim());
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
    process.kill(ownerPid, 0);
    return true;
  } catch {
    clearTerminalAttached(sessionId);
    return false;
  }
}
