#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { request } from "./client.ts";
import { sessionEventsPath } from "./paths.ts";
import { isTerminalAttached } from "./presence.ts";
import { compareSlackTs, loadSlackConfig, SlackApi } from "./slack-api.ts";
import { readSlackBinding, writeSlackBinding } from "./slack-store.ts";
import { readSession } from "./store.ts";
import type { SlackBinding } from "./types.ts";

const POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function save(binding: SlackBinding): Promise<void> {
  binding.updatedAt = new Date().toISOString();
  await writeSlackBinding(binding);
}

async function ingestSlack(binding: SlackBinding, slack: SlackApi, allowedUsers: Set<string>): Promise<void> {
  const messages = await slack.replies(binding.channelId, binding.threadTs);
  for (const message of messages) {
    if (isTerminalAttached(binding.sessionId)) return;
    if (compareSlackTs(message.ts, binding.lastSeenTs) <= 0) continue;
    binding.lastSeenTs = message.ts;
    if (!message.user || message.user === binding.botUserId || message.bot_id || !message.text?.trim()) continue;
    if (!allowedUsers.has(message.user)) continue;
    binding.queue.push({ ts: message.ts, userId: message.user, text: message.text.trim() });
    await slack.addReaction(binding.channelId, message.ts, "inbox_tray");
  }
  await save(binding);
}

async function dispatchNext(binding: SlackBinding): Promise<void> {
  if (binding.active || binding.queue.length === 0) return;
  const next = binding.queue.shift()!;
  binding.active = next;
  await save(binding);
  try {
    await request(await readSession(binding.sessionId), { type: "send", text: next.text, submit: true });
  } catch (error) {
    binding.active = null;
    binding.queue.unshift(next);
    throw error;
  } finally {
    await save(binding);
  }
}

async function completionEvents(binding: SlackBinding): Promise<Array<Record<string, unknown>>> {
  let body: Buffer;
  try {
    body = await readFile(sessionEventsPath(binding.sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (body.length <= binding.eventOffset) return [];
  const unread = body.subarray(binding.eventOffset).toString("utf8");
  const finalNewline = unread.lastIndexOf("\n");
  if (finalNewline < 0) return [];
  binding.eventOffset += Buffer.byteLength(unread.slice(0, finalNewline + 1));
  return unread
    .slice(0, finalNewline)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function publishCompletions(binding: SlackBinding, slack: SlackApi): Promise<void> {
  for (const event of await completionEvents(binding)) {
    if (event.type !== "agent-turn-complete") continue;
    if (isTerminalAttached(binding.sessionId)) {
      binding.active = null;
      continue;
    }
    const text = String(event["last-assistant-message"] ?? "").trim();
    if (!text) continue;
    await slack.postMarkdownMessage(binding.channelId, text, binding.threadTs);
    if (binding.active) {
      binding.active = null;
    }
    await save(binding);
  }
}

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error("session id required");
  const session = await readSession(sessionId);
  const config = await loadSlackConfig(session.cwd);
  const slack = new SlackApi(config.token);
  let binding = await readSlackBinding(sessionId);
  binding.status = "running";
  binding.bridgePid = process.pid;
  binding.lastError = null;
  await save(binding);

  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));
  process.on("SIGHUP", () => {
    // The relay is expected to survive the SSH client that launched it.
  });

  while (running) {
    try {
      const current = await readSession(sessionId);
      if (current.status !== "running" && current.status !== "starting") break;
      binding = await readSlackBinding(sessionId);
      if (isTerminalAttached(sessionId)) {
        binding.active = null;
        await completionEvents(binding);
        binding.lastError = null;
        await save(binding);
        await sleep(POLL_MS);
        continue;
      }
      await ingestSlack(binding, slack, config.allowedUsers);
      await publishCompletions(binding, slack);
      await dispatchNext(binding);
      binding.lastError = null;
      await save(binding);
      await sleep(POLL_MS);
    } catch (error) {
      binding.lastError = error instanceof Error ? error.message : String(error);
      await save(binding).catch(() => {});
      process.stderr.write(`[${new Date().toISOString()}] ${binding.lastError}\n`);
      await sleep(5_000);
    }
  }

  binding.status = "stopped";
  binding.bridgePid = null;
  await save(binding);
}

main().catch(async (error) => {
  const sessionId = process.argv[2];
  if (sessionId) {
    try {
      const binding = await readSlackBinding(sessionId);
      binding.status = "failed";
      binding.bridgePid = null;
      binding.lastError = error instanceof Error ? error.message : String(error);
      await save(binding);
    } catch {
      // The startup error is still written below.
    }
  }
  process.stderr.write(`agent-tui Slack bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
