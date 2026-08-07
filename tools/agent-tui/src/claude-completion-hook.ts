#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { ensureDirectories, sessionEventsPath } from "./paths";

// A Stop hook runs inside the turn: until it exits, the session keeps rendering
// "running stop hook", writes no completion event, and — because the turn has
// not ended — drops the submit key of anything delivered into its composer in
// the meantime. A blocked hook therefore costs both the Slack notification and
// the message that was supposed to arrive.
//
// Reading fd 0 synchronously is exactly that hazard: it returns only on EOF, so
// any invocation whose stdin is not closed for us hangs until the harness kills
// the hook. Bounding the read trades a missing message field for a turn that
// always ends on time.
const STDIN_TIMEOUT_MS = 2_000;

function readHookPayload(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buffered = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onData = (chunk: Buffer | string): void => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      process.stdin.off("error", finish);
      resolve(buffered);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

const sessionId = process.env.AGENT_TUI_SESSION_ID;
if (sessionId) {
  try {
    const input = JSON.parse(await readHookPayload(STDIN_TIMEOUT_MS)) as {
      hook_event_name?: string;
      last_assistant_message?: string;
    };
    const message = input.last_assistant_message?.trim();
    if (input.hook_event_name === "Stop" && message) {
      await ensureDirectories();
      const event = {
        type: "agent-turn-complete",
        harness: "claude",
        "last-assistant-message": message,
      };
      appendFileSync(sessionEventsPath(sessionId), `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  } catch {
    // Completion reporting must never disrupt the Claude Code session.
  }
}

// An unclosed stdin keeps the event loop alive, which would hold the turn open
// just as the blocking read did. The work above is finished either way.
process.exit(0);
