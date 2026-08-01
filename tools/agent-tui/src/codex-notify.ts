#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { ensureDirectories, sessionEventsPath } from "./paths";

const sessionId = process.env.AGENT_TUI_SESSION_ID;
const payload = process.argv[2];
if (sessionId && payload) {
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (event.type === "agent-turn-complete") {
      await ensureDirectories();
      appendFileSync(sessionEventsPath(sessionId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    // Notifications must never disrupt the Codex turn that emitted them.
  }
}
