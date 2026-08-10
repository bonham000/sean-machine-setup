#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { request } from "./client";
import { ensureDirectories, sessionEventsPath } from "./paths";
import { firstInputMessage } from "./session-metadata";
import { readSession } from "./store";

const sessionId = process.env.AGENT_TUI_SESSION_ID;
const payload = process.argv[2];
if (sessionId && payload) {
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (event.type === "agent-turn-complete") {
      await ensureDirectories();
      appendFileSync(sessionEventsPath(sessionId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      const firstPrompt = firstInputMessage(event);
      if (firstPrompt) {
        try {
          await request(await readSession(sessionId), { type: "confirm-first-prompt", text: firstPrompt }, 1_000);
        } catch {
          // Completion delivery remains useful even if the session is exiting.
        }
      }
    }
  } catch {
    // Notifications must never disrupt the Codex turn that emitted them.
  }
}
