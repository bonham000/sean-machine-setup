#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandArgsWithAdapters, harnessForCommand, HARNESSES, type HarnessDefinition } from "./adapters";
import { connectSocket, request } from "./client";
import { ensureDirectories, sessionDaemonLogPath, sessionLogPath, sessionSocketPath } from "./paths";
import { clearTerminalAttached, markTerminalAttached } from "./presence";
import { findDetachSequence, OUTER_TERMINAL_RESTORE, readJsonLines, writeMessage } from "./protocol";
import { singleSelect } from "./picker";
import { findRepository, sessionLabel } from "./session-metadata";
import { sessionMenu, sessionSection } from "./session-menu";
import { beginSlackHandoff } from "./slack-control";
import { listSessions, readSession, resolveSession, writeSession } from "./store";
import type { ClientRequest, ServerMessage, SessionRecord } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = resolve(HERE, "daemon.ts");
function usage(exitCode = 2): never {
  const output = `Usage:
  agent-tui
  agent-tui new [--cwd DIR] [--harness claude|codex|pi] [--detached]
  agent-tui run [--name NAME] [--cwd DIR] [--detached] -- COMMAND [ARGS...]
  agent-tui attach SESSION
  agent-tui send SESSION [--no-submit] [--stdin] [TEXT...]
  agent-tui slack SESSION
  agent-tui capture SESSION
  agent-tui list [--json]
  agent-tui stop SESSION

Cmd-L hands the session to Slack. Ctrl-\\ / Ctrl-] detaches locally.
The child TUI keeps running in either case.
`;
  (exitCode === 0 ? process.stdout : process.stderr).write(output);
  process.exit(exitCode);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function dimensions(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 };
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

async function waitUntilReady(session: SessionRecord): Promise<SessionRecord> {
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const current = await resolveSession(session.id);
      await request(current, { type: "ping" }, 500);
      return current;
    } catch (error) {
      lastError = error;
      await Bun.sleep(50);
    }
  }
  throw new Error(`Session daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function attach(session: SessionRecord): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("attach requires an interactive terminal");
  const socket = await connectSocket(session.socketPath);
  const requestId = randomUUID();
  const originalRaw = process.stdin.isRaw;
  let acknowledged = false;
  let cleaned = false;
  let presencePublished = false;
  let failure: Error | null = null;
  let detachWork: Promise<void> | null = null;
  const closed = new Promise<void>((resolvePromise, rejectPromise) => {
    socket.once("close", () => {
      if (failure) rejectPromise(failure);
      else resolvePromise();
    });
  });

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.stdout.off("resize", resize);
    process.stdin.off("data", input);
    if (presencePublished) clearTerminalAttached(session.id);
    if (process.stdin.setRawMode) process.stdin.setRawMode(originalRaw ?? false);
    process.stdin.pause();
    process.stdout.write(OUTER_TERMINAL_RESTORE);
    socket.destroy();
  };
  const resize = () => {
    if (!acknowledged) return;
    writeMessage(socket, { id: randomUUID(), type: "resize", ...dimensions() } satisfies ClientRequest);
  };
  const input = (chunk: Buffer) => {
    const detachment = findDetachSequence(chunk);
    const detachAt = detachment?.index ?? -1;
    const forwarded = detachAt >= 0 ? chunk.subarray(0, detachAt) : chunk;
    if (forwarded.length > 0) {
      writeMessage(socket, { id: randomUUID(), type: "input", data: forwarded.toString("base64") } satisfies ClientRequest);
    }
    if (detachment) {
      cleanup();
      if (detachment.action === "slack") {
        process.stdout.write("\r\n[agent-tui] Opening Slack control thread...\r\n");
        detachWork = beginSlackHandoff(session).then((binding) => {
          process.stdout.write(`[agent-tui] Slack attached: ${binding.threadUrl}\r\n`);
        });
      } else {
        process.stdout.write("\r\nDetached. Run agent-tui to reattach.\r\n");
      }
    }
  };

  socket.on(
    "data",
    readJsonLines<ServerMessage>((message) => {
      if (message.type === "response" && message.id === requestId) {
        if (!message.ok) {
          failure = new Error(message.error ?? "attach failed");
          cleanup();
          return;
        }
        acknowledged = true;
        markTerminalAttached(session.id);
        presencePublished = true;
        return;
      }
      if (message.type === "output") {
        process.stdout.write(Buffer.from(message.data, "base64"));
        return;
      }
      if (message.type === "exit") {
        cleanup();
        process.stdout.write(`\r\n[agent-tui] child exited (${message.exitCode}, signal ${message.signal})\r\n`);
      }
    }),
  );
  socket.once("error", (error) => {
    failure = error;
    cleanup();
  });
  socket.once("close", cleanup);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", input);
  process.stdout.on("resize", resize);
  writeMessage(socket, { id: requestId, type: "attach", ...dimensions() } satisfies ClientRequest);

  await closed;
  if (detachWork) await detachWork;
}

function parseRun(args: string[]): {
  name?: string;
  cwd: string;
  detached: boolean;
  command: string;
  commandArgs: string[];
} {
  const name = option(args, "--name");
  const cwd = resolve(option(args, "--cwd") ?? process.cwd());
  const detached = args.includes("--detached");
  const separator = args.indexOf("--");
  let commandAndArgs: string[];
  if (separator >= 0) {
    commandAndArgs = args.slice(separator + 1);
  } else {
    const consumed = new Set<number>();
    for (const flag of ["--name", "--cwd"]) {
      const index = args.indexOf(flag);
      if (index >= 0) {
        consumed.add(index);
        consumed.add(index + 1);
      }
    }
    commandAndArgs = args.filter((value, index) => !consumed.has(index) && value !== "--detached");
  }
  const [command, ...commandArgs] = commandAndArgs;
  if (!command) usage();
  return { name, cwd, detached, command, commandArgs };
}

async function launch(parsed: ReturnType<typeof parseRun>): Promise<SessionRecord> {
  await ensureDirectories();
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const now = new Date().toISOString();
  const repo = await findRepository(parsed.cwd);
  const harness = harnessForCommand(parsed.command);
  const record: SessionRecord = {
    id,
    name: parsed.name ?? `${harness?.id ?? basename(parsed.command)}-${id.slice(0, 6)}`,
    harness: harness?.id ?? basename(parsed.command),
    command: parsed.command,
    args: commandArgsWithAdapters(parsed.command, parsed.commandArgs),
    cwd: parsed.cwd,
    repoRoot: repo.root,
    repoName: repo.name,
    firstPrompt: null,
    status: "starting",
    daemonPid: null,
    childPid: null,
    socketPath: sessionSocketPath(id),
    logPath: sessionLogPath(id),
    daemonLogPath: sessionDaemonLogPath(id),
    createdAt: now,
    updatedAt: now,
    exitCode: null,
    signal: null,
  };
  await writeSession(record);

  const daemonRuntime = process.env.AGENT_TUI_NODE ?? "node";
  const daemonLogFd = openSync(record.daemonLogPath, "a", 0o600);
  const child = spawn(daemonRuntime, [DAEMON_PATH, id], {
    detached: true,
    stdio: ["ignore", daemonLogFd, daemonLogFd],
    env: process.env,
  });
  closeSync(daemonLogFd);
  child.unref();
  let becameReady = false;
  const launchFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      if (!becameReady) {
        reject(new Error(`Session daemon exited before startup (code ${code}, signal ${signal}); see ${record.daemonLogPath}`));
      }
    });
  });
  let ready: SessionRecord;
  try {
    ready = await Promise.race([waitUntilReady(record), launchFailure]);
  } catch (error) {
    await writeSession({
      ...record,
      status: "failed",
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
  becameReady = true;

  if (parsed.detached) {
    process.stdout.write(`${ready.id}\n`);
    return ready;
  }
  await attach(ready);
  return await readSession(ready.id);
}

async function run(args: string[]): Promise<void> {
  await launch(parseRun(args));
}

async function chooseHarness(cwd: string): Promise<HarnessDefinition | null> {
  const repo = await findRepository(cwd);
  return await singleSelect({
    title: "New agent session",
    detail: `[${repo.name}] ${repo.root}`,
    items: HARNESSES,
    renderItem: (harness) => `${harness.label}  ${harness.command}`,
  });
}

async function newSession(args: string[]): Promise<void> {
  const requestedCwd = resolve(option(args, "--cwd") ?? process.cwd());
  const repo = await findRepository(requestedCwd);
  const harnessId = option(args, "--harness");
  const harness = harnessId ? HARNESSES.find((candidate) => candidate.id === harnessId) : await chooseHarness(repo.root);
  if (!harness) {
    if (harnessId) throw new Error(`Unknown harness ${JSON.stringify(harnessId)}; choose ${HARNESSES.map((item) => item.id).join(", ")}`);
    return;
  }
  await launch({
    cwd: repo.root,
    detached: args.includes("--detached"),
    command: harness.command,
    commandArgs: [],
  });
}

async function send(args: string[]): Promise<void> {
  const query = args[0];
  if (!query) usage();
  const session = await resolveSession(query);
  const useStdin = args.includes("--stdin");
  const submit = !args.includes("--no-submit");
  const textArgs = args.slice(1).filter((arg) => arg !== "--stdin" && arg !== "--no-submit");
  const text = useStdin ? await Bun.stdin.text() : textArgs.join(" ");
  if (!text) throw new Error("send requires text or --stdin");
  await request(session, { type: "send", text, submit });
  process.stdout.write(`sent to ${session.id}\n`);
}

async function reconcileSessions(): Promise<SessionRecord[]> {
  const sessions = await listSessions();
  await Promise.all(
    sessions.map(async (session) => {
      const recoverableFailure = session.status === "failed" && session.exitCode === null && session.daemonPid !== null;
      if (sessionSection(session) !== "running" && !recoverableFailure) return;
      if (session.status === "starting" && Date.now() - Date.parse(session.createdAt) < 8_000) return;
      if (!processExists(session.daemonPid)) {
        await writeSession({
          ...session,
          status: "failed",
          daemonPid: null,
          childPid: null,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      try {
        await request(session, { type: "ping" }, 750);
        if (recoverableFailure) {
          await writeSession({ ...session, status: "running", updatedAt: new Date().toISOString() });
        }
      } catch {
        await writeSession({
          ...session,
          status: "failed",
          updatedAt: new Date().toISOString(),
        });
      }
    }),
  );
  return await listSessions();
}

async function list(json: boolean): Promise<void> {
  const sessions = await reconcileSessions();
  if (json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write("No agent-tui sessions.\n");
    return;
  }
  for (const section of ["running", "closed"] as const) {
    const grouped = sessions.filter((session) => sessionSection(session) === section);
    if (grouped.length === 0) continue;
    process.stdout.write(`[${section}]\n`);
    for (const session of grouped) process.stdout.write(`  ${sessionLabel(session)}\n`);
    process.stdout.write("\n");
  }
}

async function stopSession(session: SessionRecord): Promise<void> {
  await request(session, { type: "stop" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await readSession(session.id);
    if (sessionSection(current) === "closed") return;
    await Bun.sleep(50);
  }
}

async function manageSessions(): Promise<void> {
  await sessionMenu({
    load: reconcileSessions,
    attach,
    stop: stopSession,
    create: async (cwd) => await newSession(["--cwd", cwd]),
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return await manageSessions();
  if (command === "help" || command === "--help" || command === "-h") usage(0);
  if (command === "new") return await newSession(args);
  if (command === "run") return await run(args);
  if (command === "attach") {
    if (!args[0]) usage();
    return await attach(await resolveSession(args[0]));
  }
  if (command === "send") return await send(args);
  if (command === "slack") {
    if (!args[0]) usage();
    const binding = await beginSlackHandoff(await resolveSession(args[0]));
    process.stdout.write(`${binding.threadUrl}\n`);
    return;
  }
  if (command === "capture") {
    if (!args[0]) usage();
    const session = await resolveSession(args[0]);
    process.stdout.write(await readFile(session.logPath));
    return;
  }
  if (command === "list") return await list(args.includes("--json"));
  if (command === "stop") {
    if (!args[0]) usage();
    const session = await resolveSession(args[0]);
    await stopSession(session);
    process.stdout.write(`stopped ${session.id}\n`);
    return;
  }
  usage();
}

main().catch((error) => {
  process.stderr.write(`agent-tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
