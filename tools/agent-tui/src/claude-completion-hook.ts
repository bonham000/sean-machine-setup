#!/usr/bin/env bun

import { appendFileSync, readFileSync } from "node:fs";
import { ensureDirectories, sessionEventsPath } from "./paths";

const sessionId = process.env.AGENT_TUI_SESSION_ID;
if (sessionId) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as {
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
