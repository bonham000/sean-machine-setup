import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionEventsPath, sessionSlackLogPath } from "./paths";
import { SlackApi, loadSlackConfig } from "./slack-api";
import { readSlackBinding, writeSlackBinding } from "./slack-store";
import { readSession } from "./store";
import type { SessionRecord, SlackBinding } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = resolve(HERE, "slack-bridge.ts");
const PROMPT_PREVIEW_WORDS = 20;

function slackSafe(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackCode(value: string): string {
  return `\`${slackSafe(value).replaceAll("`", "'")}\``;
}

function promptPreview(value: string | null, wordLimit = PROMPT_PREVIEW_WORDS): string {
  if (!value) return "Terminal session attached. Waiting for the first prompt...";
  const words = value.trim().split(/\s+/);
  const preview = words.slice(0, wordLimit).join(" ");
  return words.length > wordLimit ? `${preview}...` : preview;
}

export function formatSlackThreadOpener(session: SessionRecord, machineId: string): string {
  const repo = session.repoName || basename(session.repoRoot || session.cwd) || "root";
  const agent = session.harness || basename(session.command);
  return [
    ["agent-tui", machineId, repo].map(slackCode).join(" ") + ` • ${slackCode(agent)}`,
    slackSafe(promptPreview(session.firstPrompt)),
  ].join("\n");
}

function processExists(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilBridgeReady(sessionId: string): Promise<SlackBinding> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const binding = await readSlackBinding(sessionId);
    if (binding.status === "running" && processExists(binding.bridgePid)) return binding;
    if (binding.status === "failed") throw new Error(binding.lastError ?? "Slack bridge failed to start");
    await Bun.sleep(50);
  }
  throw new Error(`Slack bridge did not become ready; see ${sessionSlackLogPath(sessionId)}`);
}

async function startBridge(binding: SlackBinding): Promise<SlackBinding> {
  await writeSlackBinding(binding);
  const logFd = openSync(sessionSlackLogPath(binding.sessionId), "a", 0o600);
  // The bridge is pure fetch, fs, and socket work, so it runs on Bun like the
  // rest of the CLI. Only the daemon needs Node, for node-pty.
  const runtime = process.env.AGENT_TUI_BUN ?? process.execPath;
  const child = spawn(runtime, [BRIDGE_PATH, binding.sessionId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();

  let becameReady = false;
  const launchFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (becameReady) return;
      reject(
        new Error(
          `Slack bridge exited before startup (code ${code}, signal ${signal}); see ${sessionSlackLogPath(binding.sessionId)}`,
        ),
      );
    });
  });
  try {
    const ready = await Promise.race([waitUntilBridgeReady(binding.sessionId), launchFailure]);
    becameReady = true;
    return ready;
  } catch (error) {
    await writeSlackBinding({
      ...binding,
      status: "failed",
      bridgePid: null,
      updatedAt: new Date().toISOString(),
      lastError: (error as Error).message,
    });
    throw error;
  }
}

export async function beginSlackHandoff(session: SessionRecord): Promise<SlackBinding> {
  try {
    const existing = await readSlackBinding(session.id);
    if (existing.status === "running" && processExists(existing.bridgePid)) return existing;
    return await startBridge({
      ...existing,
      status: "starting",
      bridgePid: null,
      updatedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const currentSession = await readSession(session.id);
  const config = await loadSlackConfig(currentSession.cwd);
  const slack = new SlackApi(config.token);
  const auth = await slack.authTest();
  const opener = formatSlackThreadOpener(currentSession, config.machineId);
  const history = await slack.history(config.channelId);
  const recentCutoffSeconds = Date.now() / 1000 - 15 * 60;
  const existingOpener = history.find(
    (message) =>
      message.user === auth.userId &&
      message.text === opener &&
      Number(message.ts.split(".")[0]) >= recentCutoffSeconds,
  );
  const threadTs = existingOpener?.ts ?? (await slack.postMessage(config.channelId, opener));
  const workspaceUrl = auth.workspaceUrl.endsWith("/") ? auth.workspaceUrl : `${auth.workspaceUrl}/`;
  const threadUrl = `${workspaceUrl}archives/${config.channelId}/p${threadTs.replace(".", "")}`;
  let eventOffset = 0;
  try {
    eventOffset = (await stat(sessionEventsPath(currentSession.id))).size;
  } catch {
    // No prior completion events.
  }
  const now = new Date().toISOString();
  const binding: SlackBinding = {
    sessionId: currentSession.id,
    status: "starting",
    bridgePid: null,
    channelId: config.channelId,
    threadTs,
    threadUrl,
    botUserId: auth.userId,
    lastSeenTs: threadTs,
    eventOffset,
    queue: [],
    active: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    pollingAnchorAt: now,
    rateLimitActive: false,
  };
  await writeSlackBinding(binding);
  return await startBridge(binding);
}
