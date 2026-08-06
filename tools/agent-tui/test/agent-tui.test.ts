import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandArgsWithAdapters } from "../src/adapters";
import { installAgentTuiConfig } from "../src/install-config";
import { ensureDirectories, runtimeDirectory } from "../src/paths";
import { extractPiAssistantText } from "../src/pi-completion-extension";
import { clearTerminalAttached, isTerminalAttached, markTerminalAttached } from "../src/presence";
import {
  detachSequenceIndex,
  OUTER_TERMINAL_RESTORE,
  sanitizePasteText,
  terminalPaste,
  terminalReplacementPaste,
} from "../src/protocol";
import { findRepository, FirstPromptCapture, sessionLabel } from "../src/session-metadata";
import { filterSessions, sessionSection } from "../src/session-menu";
import {
  compareSlackTs,
  loadSlackConfig,
  parseEnvFile,
  SlackApi,
  SlackRateLimitError,
  splitSlackMarkdown,
} from "../src/slack-api";
import { formatPollingRateLimitNotice, parseCompletionEvents, pollingPlan } from "../src/slack-bridge";
import { formatSlackThreadOpener } from "../src/slack-control";
import type { SessionRecord, SlackBinding } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/cli.ts");
const CLAUDE_HOOK = resolve(HERE, "../src/claude-completion-hook.ts");
const CODEX_NOTIFY = resolve(HERE, "../src/codex-notify.ts");
const FIXTURE = resolve(HERE, "fixture-tui.ts");
const temporaryDirectories: string[] = [];
const runningSessions: Array<{ id: string; env: Record<string, string> }> = [];

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "0123456789ab",
    name: "codex-012345",
    harness: "codex",
    command: "codex",
    args: [],
    cwd: "/Users/sean/Documents/core-repo",
    repoRoot: "/Users/sean/Documents/core-repo",
    repoName: "core-repo",
    firstPrompt: "Review the current implementation and identify risks",
    status: "running",
    daemonPid: 1,
    childPid: 2,
    socketPath: "/tmp/session.sock",
    logPath: "/tmp/session.log",
    daemonLogPath: "/tmp/session.daemon.log",
    createdAt: "2026-08-01T20:30:00.000Z",
    updatedAt: "2026-08-01T20:30:00.000Z",
    exitCode: null,
    signal: null,
    ...overrides,
  };
}

async function command(args: string[], env: Record<string, string>, stdin?: string): Promise<string> {
  const subprocess = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...globalThis.process.env, ...env },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && subprocess.stdin) {
    subprocess.stdin.write(stdin);
    subprocess.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`command failed (${exitCode}): ${stderr}`);
  return stdout;
}

afterEach(async () => {
  for (const session of runningSessions.splice(0)) {
    await command(["stop", session.id], session.env).catch(() => {});
  }
  await Bun.sleep(50);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("terminal input", () => {
  it("sanitizes terminal controls while preserving multiline Unicode text", () => {
    expect(sanitizePasteText("hello\r\n世界\u0000\u001b[31m")).toBe("hello\n世界[31m");
  });

  it("wraps input as one bracketed paste and optional submit", () => {
    expect(terminalPaste("one\ntwo", true)).toBe("\u001b[200~one\ntwo\u001b[201~\r");
    expect(terminalPaste("draft", false)).toBe("\u001b[200~draft\u001b[201~");
    expect(terminalReplacementPaste("Slack prompt", true)).toBe("\u0015\u001b[200~Slack prompt\u001b[201~\r");
  });

  it("recognizes portable and managed-terminal detach sequences", () => {
    expect(detachSequenceIndex(Buffer.from([0x1d]))).toBe(0);
    expect(detachSequenceIndex(Buffer.from([0x1c]))).toBe(0);
    expect(detachSequenceIndex(Buffer.from("before\u001b[99~after"))).toBe(6);
    expect(detachSequenceIndex(Buffer.from("ordinary input"))).toBe(-1);
  });

  it("restores terminal modes changed by a full-screen child", () => {
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[<1u");
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[?2004l");
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[?1049l");
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[?25h");
    expect(OUTER_TERMINAL_RESTORE).toContain("\r\u001b[2K");
  });

  it("captures the first submitted local prompt with editing", () => {
    const capture = new FirstPromptCapture();
    expect(capture.consume("hello worl\u007fd\r")).toBe("hello word");
  });

  it("removes terminal controls from stored prompt labels", () => {
    const capture = new FirstPromptCapture();
    expect(capture.consume("safe\u0000\u001b[31mred\r")).toBe("safered");
  });

  it("captures multiline bracketed paste and Kitty keyboard Enter", () => {
    const capture = new FirstPromptCapture();
    expect(capture.consume("\u001b[200~first line\nsecond line\u001b[201~")).toBeNull();
    expect(capture.consume("\u001b[13u")).toBe("first line second line");
  });

  it("ignores terminal replies and Kitty key-release events while capturing a prompt", () => {
    const capture = new FirstPromptCapture();
    const prompt = "we recently setup this";
    const traffic = [
      "\u001b]10;rgb:baba/bdbd/baba\u001b\\",
      "\u001b]11;rgb:1616/1616/1616\u001b\\",
      ...Array.from(prompt).flatMap((character) => [character, `\u001b[${character.codePointAt(0)};1:3u`]),
      "\r",
    ].join("");
    expect(capture.consume(traffic)).toBe(prompt);
  });

  it("captures printable Kitty key-press events when no literal text accompanies them", () => {
    const capture = new FirstPromptCapture();
    expect(capture.consume("\u001b[104;1u\u001b[105;1u\u001b[13;1u")).toBe("hi");
  });
});

describe("session metadata", () => {
  it("finds the repository root from a nested working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tui-repo-test-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(await findRepository(nested)).toEqual({ root, name: basename(root) });
  });

  it("renders stable one-line labels without internal session ids", () => {
    const record = session({ firstPrompt: "A".repeat(80) });
    const label = sessionLabel(record, new Date("2026-08-01T22:00:00.000Z"));
    expect(label).toContain("[core-repo] [codex]");
    expect(label).toContain("...");
    expect(label).not.toContain(record.id);
    expect(label).not.toContain("--config");
  });

  it("groups running sessions before closed sessions while fuzzy filtering", () => {
    const running = session({ id: "111111111111", repoName: "core-repo", status: "running" });
    const closed = session({ id: "222222222222", repoName: "core-repo", status: "ended" });
    const unrelated = session({ id: "333333333333", repoName: "website-builder", status: "running" });
    const filtered = filterSessions([closed, unrelated, running], "core codex");
    expect(filtered.map((item) => item.id)).toEqual([running.id, closed.id]);
    expect(filtered.map(sessionSection)).toEqual(["running", "closed"]);
  });

  it("keeps the default runtime socket directory in persistent user state", () => {
    const previousHome = process.env.AGENT_TUI_HOME;
    const previousRuntime = process.env.AGENT_TUI_RUNTIME;
    process.env.AGENT_TUI_HOME = "/tmp/agent-tui-state-test";
    delete process.env.AGENT_TUI_RUNTIME;
    try {
      expect(runtimeDirectory()).toBe("/tmp/agent-tui-state-test/runtime");
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_TUI_HOME;
      else process.env.AGENT_TUI_HOME = previousHome;
      if (previousRuntime === undefined) delete process.env.AGENT_TUI_RUNTIME;
      else process.env.AGENT_TUI_RUNTIME = previousRuntime;
    }
  });
});

describe("Slack transport primitives", () => {
  it("formats the handoff opener from machine, repo, harness, and a 20-word prompt preview", () => {
    const firstPrompt = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one <unsafe>";
    expect(formatSlackThreadOpener(session({ firstPrompt }), "mac-mini")).toBe(
      [
        "`agent-tui` `mac-mini` `core-repo` • `codex`",
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty...",
      ].join("\n"),
    );
  });

  it("uses the terminal-attached fallback before a first prompt is captured", () => {
    expect(formatSlackThreadOpener(session({ firstPrompt: null }), "mbp")).toContain(
      "Terminal session attached. Waiting for the first prompt...",
    );
  });

  it("parses machine and Slack configuration without exposing comments", () => {
    expect(parseEnvFile('# managed\nMACHINE_ID=mbp\nTOKEN="secret"\n')).toEqual({
      MACHINE_ID: "mbp",
      TOKEN: "secret",
    });
  });

  it("reads Slack control credentials from global config instead of the active repo", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-slack-config-test-"));
    temporaryDirectories.push(home);
    const repo = join(home, "Documents", "example-repo");
    const configDirectory = join(home, ".config", "agent-tui");
    await mkdir(repo, { recursive: true });
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(repo, ".env"),
      "SLACK_BOT_TOKEN_AGENT_COMMS=repo-token\nSLACK_AGENT_COMMS_CHANNEL=repo-channel\nSLACK_AGENT_COMMS_ALLOWED_USERS=repo-user\n",
    );
    await writeFile(
      join(configDirectory, ".env"),
      "SLACK_BOT_TOKEN_AGENT_COMMS=global-token\nSLACK_AGENT_COMMS_CHANNEL=global-channel\nSLACK_AGENT_COMMS_ALLOWED_USERS=user-1,user-2\n",
    );

    const keys = [
      "HOME",
      "AGENT_TUI_ENV_FILE",
      "SLACK_BOT_TOKEN_AGENT_COMMS",
      "SLACK_AGENT_COMMS_CHANNEL",
      "SLACK_AGENT_COMMS_ALLOWED_USERS",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.HOME = home;
    for (const key of keys.slice(1)) delete process.env[key];
    try {
      const config = await loadSlackConfig(repo);
      expect(config.token).toBe("global-token");
      expect(config.channelId).toBe("global-channel");
      expect(config.allowedUsers).toEqual(new Set(["user-1", "user-2"]));
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("installs a private global config from the vault-loaded core environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-config-install-test-"));
    temporaryDirectories.push(home);
    const coreRepo = join(home, "Documents", "core-repo");
    await mkdir(coreRepo, { recursive: true });
    let refreshedRepo: string | undefined;
    const destination = await installAgentTuiConfig({
      home,
      coreRepo,
      loadVault: async (repoPath) => {
        refreshedRepo = repoPath;
        await writeFile(
          join(repoPath, ".env"),
          "SLACK_BOT_TOKEN_AGENT_COMMS=vault-token\nSLACK_AGENT_COMMS_CHANNEL=vault-channel\nSLACK_AGENT_COMMS_ALLOWED_USERS=vault-user\nUNRELATED_SECRET=excluded\n",
        );
      },
    });

    expect(refreshedRepo).toBe(coreRepo);
    expect(destination).toBe(join(home, ".config", "agent-tui", ".env"));
    const installed = await readFile(destination, "utf8");
    expect(installed).toContain("SLACK_BOT_TOKEN_AGENT_COMMS=vault-token");
    expect(installed).not.toContain("UNRELATED_SECRET");
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("compares Slack timestamps without floating-point precision loss", () => {
    expect(compareSlackTs("1784944939.433090", "1784944939.433089")).toBeGreaterThan(0);
  });

  it("surfaces Slack Retry-After without issuing an immediate retry", async () => {
    let calls = 0;
    const slack = new SlackApi("token", async () => {
      calls += 1;
      return Response.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "retry-after": "17" } },
      );
    });

    const error = await slack.replies("channel", "thread").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SlackRateLimitError);
    expect((error as SlackRateLimitError).retryAfterMs).toBe(17_000);
    expect(calls).toBe(1);
  });

  it("backs Slack polling off from 5s to 10s to 30s with jitter", () => {
    const now = Date.parse("2026-08-05T00:10:00.000Z");
    const binding = {
      createdAt: new Date(now).toISOString(),
      pollingAnchorAt: new Date(now).toISOString(),
    } as SlackBinding;

    expect(pollingPlan(binding, now + 30_000, () => 0.5)).toEqual({
      phase: "0–1 minute",
      intervalMs: 5_000,
      delayMs: 5_000,
    });
    expect(pollingPlan(binding, now + 2 * 60_000, () => 0.5).intervalMs).toBe(10_000);
    expect(pollingPlan(binding, now + 10 * 60_000, () => 0.5).intervalMs).toBe(30_000);
    expect(pollingPlan(binding, now + 30_000, () => 0).delayMs).toBe(4_500);
    expect(pollingPlan(binding, now + 30_000, () => 1).delayMs).toBe(5_500);
  });

  it("describes the active polling phase when reporting a 429", () => {
    const notice = formatPollingRateLimitNotice(new SlackRateLimitError("conversations.replies", 42_000), {
      phase: "1–5 minutes",
      intervalMs: 10_000,
      delayMs: 10_400,
    });

    expect(notice).toContain("HTTP 429");
    expect(notice).toContain("nominal interval: 10s");
    expect(notice).toContain("jittered interval: 10.4s");
    expect(notice).toContain("42s retry pause");
  });

  it("does not advance completion offsets until the caller handles each event", () => {
    const first = '{"type":"agent-turn-complete","last-assistant-message":"one"}\n';
    const second = '{"type":"agent-turn-complete","last-assistant-message":"two"}\n';
    const events = parseCompletionEvents(Buffer.from(first + second), 0);

    expect(events.map(({ nextOffset }) => nextOffset)).toEqual([Buffer.byteLength(first), Buffer.byteLength(first + second)]);
    expect(events[0]?.event["last-assistant-message"]).toBe("one");
  });

  it("publishes agent output as a native Slack Markdown block", async () => {
    let payload: Record<string, unknown> | undefined;
    const slack = new SlackApi("token", async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, ts: "123.456" });
    });
    const markdown = "# Summary\n\n**Priori Labs**\n\n| Repo | Tier |\n| --- | --- |\n| abacus | client |";

    expect(await slack.postMarkdownMessage("channel", markdown, "thread")).toBe("123.456");
    expect(payload).toEqual({
      channel: "channel",
      text: markdown,
      blocks: [{ type: "markdown", text: markdown }],
      thread_ts: "thread",
    });
  });

  it("splits oversized Markdown at paragraph boundaries", () => {
    expect(splitSlackMarkdown("first paragraph\n\nsecond paragraph", 20)).toEqual([
      "first paragraph",
      "second paragraph",
    ]);
  });

  it("adds harness completion adapters without changing unknown TUIs", () => {
    const codexArgs = commandArgsWithAdapters("codex", ["--model", "test"], "/runtime/bun");
    expect(codexArgs[0]).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs[1]).toBe("--config");
    expect(codexArgs[2]).toContain('notify=["/runtime/bun"');
    expect(
      commandArgsWithAdapters("codex", ["--dangerously-bypass-approvals-and-sandbox"], "/runtime/bun").filter(
        (arg) => arg === "--dangerously-bypass-approvals-and-sandbox",
      ),
    ).toHaveLength(1);
    const kimiArgs = commandArgsWithAdapters("kimi", ["--model", "test"], "/runtime/bun");
    expect(kimiArgs).toEqual(["--auto", "--model", "test"]);
    expect(commandArgsWithAdapters("kimi", ["--auto"], "/runtime/bun")).toEqual(["--auto"]);
    const piArgs = commandArgsWithAdapters("pi", ["--model", "test"], "/runtime/bun");
    expect(piArgs[0]).toBe("--extension");
    expect(piArgs[1]).toEndWith("/pi-completion-extension.ts");
    expect(piArgs.slice(2)).toEqual(["--model", "test"]);
    const claudeArgs = commandArgsWithAdapters("claude", ["--model", "test"], "/runtime/bun");
    expect(claudeArgs[0]).toBe("--dangerously-skip-permissions");
    expect(claudeArgs[1]).toBe("--settings");
    const claudeSettings = JSON.parse(claudeArgs[2] ?? "") as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(claudeSettings.hooks.Stop[0]?.hooks[0]?.command).toContain("claude-completion-hook.ts");
    expect(claudeArgs.slice(3)).toEqual(["--model", "test"]);
    expect(
      commandArgsWithAdapters("claude", ["--dangerously-skip-permissions"], "/runtime/bun").filter(
        (arg) => arg === "--dangerously-skip-permissions",
      ),
    ).toHaveLength(1);
    expect(commandArgsWithAdapters("unknown", ["--model", "test"], "/runtime/bun")).toEqual(["--model", "test"]);
  });

  it("extracts the final text response from a Pi completion", () => {
    expect(
      extractPiAssistantText([
        { role: "assistant", content: [{ type: "text", text: "earlier" }] },
        { role: "toolResult", content: "ignored" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "private" },
            { type: "text", text: "final answer" },
          ],
        },
      ]),
    ).toBe("final answer");
  });

  it("persists Codex completion notifications for the Slack bridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-notify-test-"));
    temporaryDirectories.push(home);
    const event = {
      type: "agent-turn-complete",
      "thread-id": "thread-1",
      "last-assistant-message": "finished",
    };
    const subprocess = Bun.spawn([process.execPath, CODEX_NOTIFY, JSON.stringify(event)], {
      env: { ...process.env, AGENT_TUI_HOME: home, AGENT_TUI_SESSION_ID: "session-1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await subprocess.exited).toBe(0);
    const saved = await readFile(join(home, "sessions", "session-1.events.jsonl"), "utf8");
    expect(JSON.parse(saved)).toEqual(event);
  });

  it("persists Claude completion hooks for the Slack bridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-claude-hook-test-"));
    temporaryDirectories.push(home);
    const input = {
      hook_event_name: "Stop",
      session_id: "claude-session",
      last_assistant_message: "claude finished",
    };
    const subprocess = Bun.spawn([process.execPath, CLAUDE_HOOK], {
      env: { ...process.env, AGENT_TUI_HOME: home, AGENT_TUI_SESSION_ID: "session-1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    subprocess.stdin.write(JSON.stringify(input));
    subprocess.stdin.end();
    expect(await subprocess.exited).toBe(0);
    const saved = await readFile(join(home, "sessions", "session-1.events.jsonl"), "utf8");
    expect(JSON.parse(saved)).toEqual({
      type: "agent-turn-complete",
      harness: "claude",
      "last-assistant-message": "claude finished",
    });
  });
});

describe("node runtime compatibility", () => {
  // The session daemon and the Slack bridge are spawned with `node`, which only
  // strips types. Non-erasable syntax (parameter properties, enums, namespaces)
  // parses under Bun but crashes those processes at startup.
  it("keeps every source file loadable under Node type stripping", async () => {
    const sources = resolve(HERE, "../src");
    const scan = `
      const { stripTypeScriptTypes } = require("node:module");
      const { readdirSync, readFileSync } = require("node:fs");
      const { join } = require("node:path");
      for (const file of readdirSync(${JSON.stringify(sources)}).filter((name) => name.endsWith(".ts"))) {
        try {
          stripTypeScriptTypes(readFileSync(join(${JSON.stringify(sources)}, file), "utf8"), { mode: "strip" });
        } catch (error) {
          console.log(file + ": " + String(error.message).split("\\n")[0]);
        }
      }
    `;
    const scanner = Bun.spawn(["node", "--no-warnings", "-e", scan], { stdout: "pipe", stderr: "pipe" });
    const offenders = (await new Response(scanner.stdout).text()).trim();

    expect(await scanner.exited).toBe(0);
    expect(offenders).toBe("");
  });
});

describe("terminal presence", () => {
  it("publishes and clears the local attachment state used to pause Slack", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-presence-test-"));
    temporaryDirectories.push(home);
    const previousHome = process.env.AGENT_TUI_HOME;
    const previousRuntime = process.env.AGENT_TUI_RUNTIME;
    process.env.AGENT_TUI_HOME = home;
    process.env.AGENT_TUI_RUNTIME = join(home, "runtime");
    try {
      await ensureDirectories();
      expect(isTerminalAttached("session-1")).toBe(false);
      markTerminalAttached("session-1");
      expect(isTerminalAttached("session-1")).toBe(true);
      clearTerminalAttached("session-1");
      expect(isTerminalAttached("session-1")).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_TUI_HOME;
      else process.env.AGENT_TUI_HOME = previousHome;
      if (previousRuntime === undefined) delete process.env.AGENT_TUI_RUNTIME;
      else process.env.AGENT_TUI_RUNTIME = previousRuntime;
    }
  });
});

describe("session daemon", () => {
  it("keeps a PTY child alive and injects a multiline prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-test-"));
    temporaryDirectories.push(home);
    const env = {
      AGENT_TUI_HOME: home,
      AGENT_TUI_RUNTIME: join(home, "runtime"),
    };
    const id = (await command(["run", "--detached", "--name", "fixture", "--", process.execPath, FIXTURE], env)).trim();
    runningSessions.push({ id, env });

    const started = JSON.parse(await readFile(join(home, "sessions", `${id}.json`), "utf8")) as { daemonPid: number };
    process.kill(started.daemonPid, "SIGHUP");
    await Bun.sleep(50);

    await command(["send", id, "--stdin"], env, "first line\nsecond line");
    await Bun.sleep(100);
    const capture = await command(["capture", id], env);

    expect(capture).toContain('RECEIVED:"first line\\nsecond line"');

    const record = JSON.parse(await readFile(join(home, "sessions", `${id}.json`), "utf8")) as { status: string };
    expect(record.status).toBe("running");
    expect((record as { firstPrompt?: string }).firstPrompt).toBe("first line second line");

    const humanList = await command(["list"], env);
    expect(humanList).toContain("[running]");
    expect(humanList).toContain("first line second line");
    expect(humanList).not.toContain(id);

    await writeFile(join(home, "sessions", `${id}.slack.json`), '{"status":"running"}\n');
    const listed = JSON.parse(await command(["list", "--json"], env)) as Array<{ id: string }>;
    expect(listed.map((session) => session.id)).toEqual([id]);
  });
});
