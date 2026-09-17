#!/usr/bin/env bun

import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "./client";
import { ensureDirectories, sessionEventsPath } from "./paths";
import { firstInputMessage, isUserTurnCompletion } from "./session-metadata";
import { readSession } from "./store";

// Kimi has no launch-scoped config injection (no --settings/--config
// equivalent), so this Stop hook is installed once into
// $KIMI_CODE_HOME/config.toml by install-config.ts and fires for every Kimi
// session on the machine; sessions not owned by agent-tui are ignored via
// AGENT_TUI_SESSION_ID.
//
// The hook payload carries no transcript, but by the time Stop fires the
// session's wire.jsonl already holds the final agent.message.appended record
// (verified against kimi-code 0.43.x; only bookkeeping records land after
// Stop). Reading it here is what lets a detached session's response reach
// Slack.
//
// Same hazard as the Claude hook: Stop runs inside the turn, so the stdin
// read is bounded and the installed timeout is short.
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

export function kimiSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"), "sessions");
}

export function findKimiWirePath(sessionsRoot: string, sessionId: string): string | null {
  let workspaces: string[];
  try {
    workspaces = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    const candidate = join(sessionsRoot, workspace, sessionId, "agents", "main", "wire.jsonl");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not the workspace holding this session.
    }
  }
  return null;
}

export type KimiTurn = {
  inputMessages: string[];
  lastAssistantMessage: string | null;
};

export function extractKimiTurn(wireText: string): KimiTurn {
  const inputMessages: string[] = [];
  let lastAssistantMessage: string | null = null;
  for (const line of wireText.split("\n")) {
    if (!line) continue;
    let record: {
      type?: string;
      message?: { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "agent.message.appended") continue;
    const message = record.message?.message;
    if (!message || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!.trim())
      .filter(Boolean)
      .join("\n\n");
    if (message.role === "user") {
      if (text) inputMessages.push(text);
    } else if (message.role === "assistant") {
      // A turn can end with tool calls and no final text; keep the last text
      // the assistant produced rather than wiping it with an empty record.
      if (text) lastAssistantMessage = text;
    }
  }
  return { inputMessages, lastAssistantMessage };
}

async function main(): Promise<void> {
  const agentTuiSessionId = process.env.AGENT_TUI_SESSION_ID;
  if (!agentTuiSessionId) return;
  try {
    const input = JSON.parse(await readHookPayload(STDIN_TIMEOUT_MS)) as {
      hook_event_name?: string;
      session_id?: string;
    };
    if (input.hook_event_name === "Stop" && input.session_id) {
      const wirePath = findKimiWirePath(kimiSessionsRoot(), input.session_id);
      const turn = wirePath ? extractKimiTurn(readFileSync(wirePath, "utf8")) : null;
      if (turn?.lastAssistantMessage) {
        await ensureDirectories();
        const event = {
          type: "agent-turn-complete",
          harness: "kimi",
          "input-messages": turn.inputMessages,
          "last-assistant-message": turn.lastAssistantMessage,
        };
        if (isUserTurnCompletion(event)) {
          appendFileSync(sessionEventsPath(agentTuiSessionId), `${JSON.stringify(event)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          const firstPrompt = firstInputMessage(event);
          if (firstPrompt) {
            try {
              await request(await readSession(agentTuiSessionId), { type: "confirm-first-prompt", text: firstPrompt }, 1_000);
            } catch {
              // Completion delivery remains useful even if the session is exiting.
            }
          }
        }
      }
    }
  } catch {
    // Completion reporting must never disrupt the Kimi session.
  }
}

if (import.meta.main) {
  await main();
  // An unclosed stdin keeps the event loop alive, which would hold the turn
  // open just as the blocking read did. The work above is finished either way.
  process.exit(0);
}
