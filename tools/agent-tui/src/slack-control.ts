import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionEventsPath, sessionSlackLogPath } from "./paths";
import { SlackApi, loadSlackConfig } from "./slack-api";
import { readSlackBinding, writeSlackBinding } from "./slack-store";
import type { SessionRecord, SlackBinding } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = resolve(HERE, "slack-bridge.ts");

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
  const child = spawn(process.env.AGENT_TUI_NODE ?? "node", [BRIDGE_PATH, binding.sessionId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();
  child.once("error", () => {});
  return await waitUntilBridgeReady(binding.sessionId);
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

  const config = await loadSlackConfig(session.cwd);
  const slack = new SlackApi(config.token);
  const auth = await slack.authTest();
  const label = basename(session.command);
  const opener = [
    `🤖 \`[agent-tui]\` *${config.machineId}* | \`${label}\` | \`${session.name}\``,
    `cwd \`${session.cwd}\``,
    "This live terminal session is attached. Send instructions in this thread.",
  ].join("\n");
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
    eventOffset = (await stat(sessionEventsPath(session.id))).size;
  } catch {
    // No prior completion events.
  }
  const now = new Date().toISOString();
  const binding: SlackBinding = {
    sessionId: session.id,
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
  };
  await writeSlackBinding(binding);
  return await startBridge(binding);
}
