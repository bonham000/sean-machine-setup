#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { request } from "./client.ts";
import { sessionEventsPath } from "./paths.ts";
import { isTerminalAttached } from "./presence.ts";
import { compareSlackTs, loadSlackConfig, SlackApi, SlackRateLimitError, withMention } from "./slack-api.ts";
import { readSlackBinding, writeSlackBinding } from "./slack-store.ts";
import { readSession } from "./store.ts";
import type { SlackBinding } from "./types.ts";

const ATTACHED_CHECK_MS = 2_000;
const POLL_JITTER_RATIO = 0.1;

export type PollPlan = {
  phase: "0–1 minute" | "1–5 minutes" | "after 5 minutes";
  intervalMs: number;
  delayMs: number;
};

export type CompletionEvent = {
  event: Record<string, unknown>;
  nextOffset: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function pollingPlan(binding: SlackBinding, now = Date.now(), random = Math.random): PollPlan {
  const anchor = Date.parse(binding.pollingAnchorAt ?? binding.createdAt);
  const elapsed = Math.max(0, now - (Number.isFinite(anchor) ? anchor : now));
  const phase = elapsed < 60_000 ? "0–1 minute" : elapsed < 5 * 60_000 ? "1–5 minutes" : "after 5 minutes";
  const intervalMs = elapsed < 60_000 ? 5_000 : elapsed < 5 * 60_000 ? 10_000 : 30_000;
  const jitter = 1 + (random() * 2 - 1) * POLL_JITTER_RATIO;
  return { phase, intervalMs, delayMs: Math.round(intervalMs * jitter) };
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

    const isAllowedInbound =
      Boolean(message.user) &&
      message.user !== binding.botUserId &&
      !message.bot_id &&
      Boolean(message.text?.trim()) &&
      allowedUsers.has(message.user!);

    if (isAllowedInbound) {
      binding.queue.push({ ts: message.ts, userId: message.user!, text: message.text!.trim() });
      binding.pollingAnchorAt = new Date().toISOString();
    }
    binding.lastSeenTs = message.ts;
    // Persist the message before any best-effort acknowledgement or PTY write.
    await save(binding);

    if (isAllowedInbound) {
      try {
        await slack.addReaction(binding.channelId, message.ts, "inbox_tray");
      } catch (error) {
        process.stderr.write(
          `[${new Date().toISOString()}] Slack acknowledgement failed; message remains queued: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
  }
}

async function dispatchNext(binding: SlackBinding): Promise<void> {
  if (binding.active || binding.queue.length === 0 || isTerminalAttached(binding.sessionId)) return;
  const next = binding.queue.shift()!;
  binding.active = next;
  await save(binding);
  try {
    await request(await readSession(binding.sessionId), {
      type: "send",
      text: next.text,
      submit: true,
      onlyWhenDetached: true,
      replaceDraft: true,
    });
  } catch (error) {
    binding.active = null;
    binding.queue.unshift(next);
    throw error;
  } finally {
    await save(binding);
  }
}

export function parseCompletionEvents(body: Buffer, offset: number): CompletionEvent[] {
  if (body.length <= offset) return [];
  const unread = body.subarray(offset).toString("utf8");
  const finalNewline = unread.lastIndexOf("\n");
  if (finalNewline < 0) return [];

  const events: CompletionEvent[] = [];
  let nextOffset = offset;
  for (const lineWithNewline of unread.slice(0, finalNewline + 1).match(/.*\n/g) ?? []) {
    nextOffset += Buffer.byteLength(lineWithNewline);
    const line = lineWithNewline.slice(0, -1);
    if (!line) continue;
    events.push({ event: JSON.parse(line) as Record<string, unknown>, nextOffset });
  }
  return events;
}

async function completionEvents(binding: SlackBinding): Promise<CompletionEvent[]> {
  try {
    return parseCompletionEvents(await readFile(sessionEventsPath(binding.sessionId)), binding.eventOffset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function lastPostableCompletion(pending: CompletionEvent[]): number {
  let last = -1;
  for (const [index, { event }] of pending.entries()) {
    if (event.type !== "agent-turn-complete") continue;
    if (String(event["last-assistant-message"] ?? "").trim()) last = index;
  }
  return last;
}

async function publishCompletions(
  binding: SlackBinding,
  slack: SlackApi,
  notifyUserId: string | null,
): Promise<void> {
  const pending = await completionEvents(binding);
  // Turns that complete while the terminal is attached stay queued and flush
  // together on detach. Mention only the final one so a backlog pings once
  // instead of once per queued turn.
  const mentionAt = lastPostableCompletion(pending);

  for (const [index, { event, nextOffset }] of pending.entries()) {
    if (event.type === "agent-turn-complete") {
      if (isTerminalAttached(binding.sessionId)) return;
      const text = String(event["last-assistant-message"] ?? "").trim();
      if (text) {
        await slack.postMarkdownMessage(
          binding.channelId,
          text,
          binding.threadTs,
          index === mentionAt ? notifyUserId : null,
        );
        binding.pollingAnchorAt = new Date().toISOString();
      }
      binding.active = null;
    }
    // The daemon could not get the harness to accept the message. Nobody on
    // Slack can see that the text is sitting in the composer, and leaving the
    // binding active would silently swallow everything queued behind it too.
    if (event.type === "agent-submit-failed") {
      if (isTerminalAttached(binding.sessionId)) return;
      await slack.postMarkdownMessage(
        binding.channelId,
        [
          "*Message not delivered.* The session accepted the text but never submitted it,",
          "so it is sitting unsent in its input box and no reply is coming.",
          "Reattach to that session and press enter, or send it again.",
        ].join(" "),
        binding.threadTs,
        notifyUserId,
      );
      binding.pollingAnchorAt = new Date().toISOString();
      binding.active = null;
    }
    // Advance only after the event has been posted or intentionally ignored.
    binding.eventOffset = nextOffset;
    await save(binding);
  }
}

async function discardLocalCompletions(binding: SlackBinding): Promise<void> {
  for (const { event, nextOffset } of await completionEvents(binding)) {
    if (event.type === "agent-turn-complete" || event.type === "agent-submit-failed") binding.active = null;
    binding.eventOffset = nextOffset;
    await save(binding);
  }
}

export function formatPollingRateLimitNotice(error: SlackRateLimitError, plan: PollPlan): string {
  const retrySeconds = Math.ceil(error.retryAfterMs / 1_000);
  const actualSeconds = (plan.delayMs / 1_000).toFixed(1);
  return [
    "⚠️ `agent-tui` Slack polling hit HTTP 429 on `conversations.replies`.",
    `Polling phase: ${plan.phase}; nominal interval: ${plan.intervalMs / 1_000}s; jittered interval: ${actualSeconds}s.`,
    `Configured schedule: 5s for 0–1 minute, 10s for 1–5 minutes, then 30s. Slack requested a ${retrySeconds}s retry pause.`,
  ].join("\n");
}

async function reportPollingRateLimit(
  binding: SlackBinding,
  slack: SlackApi,
  error: SlackRateLimitError,
  plan: PollPlan,
  notifyUserId: string | null,
): Promise<void> {
  if (binding.rateLimitActive) return;
  try {
    // Degraded relay is exactly the condition the user cannot infer from
    // silence, so it mentions too.
    await slack.postMessage(
      binding.channelId,
      withMention(formatPollingRateLimitNotice(error, plan), notifyUserId),
      binding.threadTs,
    );
    binding.rateLimitActive = true;
    await save(binding);
  } catch (noticeError) {
    process.stderr.write(
      `[${new Date().toISOString()}] Could not post polling rate-limit notice: ${
        noticeError instanceof Error ? noticeError.message : String(noticeError)
      }\n`,
    );
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
    let plan = pollingPlan(binding);
    try {
      const current = await readSession(sessionId);
      if (current.status !== "running" && current.status !== "starting") break;
      binding = await readSlackBinding(sessionId);
      if (isTerminalAttached(sessionId)) {
        await discardLocalCompletions(binding);
        binding.lastError = null;
        await save(binding);
        await sleep(ATTACHED_CHECK_MS);
        continue;
      }
      plan = pollingPlan(binding);
      await ingestSlack(binding, slack, config.allowedUsers);
      binding.rateLimitActive = false;
      await publishCompletions(binding, slack, config.notifyUserId);
      await dispatchNext(binding);
      binding.lastError = null;
      await save(binding);
      await sleep(pollingPlan(binding).delayMs);
    } catch (error) {
      binding.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof SlackRateLimitError && error.method === "conversations.replies") {
        await reportPollingRateLimit(binding, slack, error, plan, config.notifyUserId);
      }
      await save(binding).catch(() => {});
      process.stderr.write(`[${new Date().toISOString()}] ${binding.lastError}\n`);
      await sleep(error instanceof SlackRateLimitError ? Math.max(error.retryAfterMs, plan.delayMs) : 5_000);
    }
  }

  binding.status = "stopped";
  binding.bridgePid = null;
  await save(binding);
}

if (import.meta.main) {
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
}
