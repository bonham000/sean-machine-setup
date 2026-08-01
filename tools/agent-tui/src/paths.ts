import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateRoot(): string {
  return process.env.AGENT_TUI_HOME ?? join(homedir(), ".local", "state", "agent-tui");
}

export function sessionsDirectory(): string {
  return join(stateRoot(), "sessions");
}

export function runtimeDirectory(): string {
  return process.env.AGENT_TUI_RUNTIME ?? join(stateRoot(), "runtime");
}

export function sessionRecordPath(id: string): string {
  return join(sessionsDirectory(), `${id}.json`);
}

export function sessionLogPath(id: string): string {
  return join(sessionsDirectory(), `${id}.log`);
}

export function sessionDaemonLogPath(id: string): string {
  return join(sessionsDirectory(), `${id}.daemon.log`);
}

export function sessionSlackPath(id: string): string {
  return join(sessionsDirectory(), `${id}.slack.json`);
}

export function sessionSlackLogPath(id: string): string {
  return join(sessionsDirectory(), `${id}.slack.log`);
}

export function sessionEventsPath(id: string): string {
  return join(sessionsDirectory(), `${id}.events.jsonl`);
}

export function sessionAttachedPath(id: string): string {
  return join(runtimeDirectory(), `${id}.attached`);
}

export function sessionSocketPath(id: string): string {
  return join(runtimeDirectory(), `${id}.sock`);
}

export async function ensureDirectories(): Promise<void> {
  for (const path of [stateRoot(), sessionsDirectory(), runtimeDirectory()]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}
