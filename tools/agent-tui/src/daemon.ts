#!/usr/bin/env bun

import { appendFileSync, closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename } from "node:path";
import * as pty from "node-pty";
import { ensureNodePtyHelper } from "./node-pty-helper.ts";
import { ensureDirectories } from "./paths.ts";
import { clearTerminalAttached, markTerminalAttached } from "./presence.ts";
import { readJsonLines, terminalPaste, writeMessage } from "./protocol.ts";
import { FirstPromptCapture, withFirstPrompt } from "./session-metadata.ts";
import { readSession, writeSession } from "./store.ts";
import type { ClientRequest, ServerMessage, SessionRecord } from "./types.ts";

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;

function fail(message: string): never {
  process.stderr.write(`agent-tui daemon: ${message}\n`);
  process.exit(1);
}

function replayLog(record: SessionRecord, socket: Socket): void {
  try {
    const size = statSync(record.logPath).size;
    const body = readFileSync(record.logPath);
    const replay = size > MAX_REPLAY_BYTES ? body.subarray(body.length - MAX_REPLAY_BYTES) : body;
    if (replay.length > 0) writeMessage(socket, { type: "output", data: replay.toString("base64"), replay: true });
  } catch {
    // No output has been written yet.
  }
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) fail("session id required");
  await ensureDirectories();
  await ensureNodePtyHelper();
  let record = await readSession(id);
  const promptCapture = new FirstPromptCapture();
  let writeQueue = Promise.resolve();
  const persistRecord = (): Promise<void> => {
    const snapshot = record;
    writeQueue = writeQueue.then(async () => await writeSession(snapshot));
    return writeQueue;
  };
  const rememberFirstPrompt = (value: string): void => {
    const updated = withFirstPrompt(record, value);
    if (updated === record) return;
    record = updated;
    void persistRecord();
  };
  clearTerminalAttached(record.id);

  try {
    unlinkSync(record.socketPath);
  } catch {
    // The socket normally does not exist on first start.
  }

  const logFd = openSync(record.logPath, "a", 0o600);
  let attached: Socket | null = null;
  const terminal = pty.spawn(record.command, record.args, {
    name: process.env.TERM || "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: record.cwd,
    env: {
      ...process.env,
      AGENT_TUI_SESSION_ID: record.id,
      AGENT_TUI_SESSION_NAME: record.name,
    },
  });
  terminal.onData((data) => {
    appendFileSync(logFd, data);
    if (attached && !attached.destroyed) {
      writeMessage(attached, { type: "output", data: Buffer.from(data).toString("base64") });
    }
  });

  record = {
    ...record,
    status: "running",
    daemonPid: process.pid,
    childPid: terminal.pid,
    updatedAt: new Date().toISOString(),
  };
  await persistRecord();

  const server = createServer((socket) => {
    socket.on(
      "data",
      readJsonLines<ClientRequest>((message) => {
        const respond = (ok: boolean, error?: string) =>
          writeMessage(socket, { type: "response", id: message.id, ok, error, session: record });

        if (message.type === "ping") {
          respond(true);
          return;
        }
        if (message.type === "attach") {
          if (attached && !attached.destroyed && attached !== socket) {
            respond(false, "another terminal is already attached");
            return;
          }
          attached = socket;
          markTerminalAttached(record.id);
          terminal.resize(Math.max(20, message.cols), Math.max(5, message.rows));
          respond(true);
          replayLog(record, socket);
          return;
        }
        if (message.type === "input") {
          const input = Buffer.from(message.data, "base64").toString("utf8");
          if (!record.firstPrompt) {
            const firstPrompt = promptCapture.consume(input);
            if (firstPrompt) rememberFirstPrompt(firstPrompt);
          }
          terminal.write(input);
          respond(true);
          return;
        }
        if (message.type === "resize") {
          terminal.resize(Math.max(20, message.cols), Math.max(5, message.rows));
          respond(true);
          return;
        }
        if (message.type === "send") {
          if (!record.firstPrompt) {
            if (message.submit) rememberFirstPrompt(message.text);
            else promptCapture.consume(`\u001b[200~${message.text}\u001b[201~`);
          }
          terminal.write(terminalPaste(message.text, message.submit));
          respond(true);
          return;
        }
        if (message.type === "stop") {
          respond(true);
          terminal.kill("SIGTERM");
        }
      }),
    );
    socket.on("close", () => {
      if (attached === socket) {
        attached = null;
        clearTerminalAttached(record.id);
      }
    });
    socket.on("error", () => {
      if (attached === socket) {
        attached = null;
        clearTerminalAttached(record.id);
      }
    });
  });

  terminal.onExit(async ({ exitCode, signal }) => {
    const normalizedSignal = signal ?? null;
    record = {
      ...record,
      status: exitCode === 0 ? "ended" : "failed",
      exitCode,
      signal: normalizedSignal,
      updatedAt: new Date().toISOString(),
    };
    await persistRecord();
    const message: ServerMessage = { type: "exit", exitCode, signal: normalizedSignal };
    if (attached && !attached.destroyed) writeMessage(attached, message);
    server.close();
    clearTerminalAttached(record.id);
    closeSync(logFd);
    try {
      unlinkSync(record.socketPath);
    } catch {
      // Already removed.
    }
    process.exit(exitCode === 0 ? 0 : 1);
  });

  server.listen(record.socketPath, () => {
    process.stdout.write(`agent-tui daemon ${record.id} running ${basename(record.command)}\n`);
  });

  const shutdown = () => terminal.kill("SIGTERM");
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", () => {
    // SSH disconnects must not terminate the detached PTY owner.
  });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
