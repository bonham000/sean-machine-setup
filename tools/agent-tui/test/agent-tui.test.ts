import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandArgsWithAdapters } from "../src/adapters";
import { installAgentTuiConfig } from "../src/install-config";
import { ensureDirectories, runtimeDirectory, sessionEventsPath } from "../src/paths";
import { KeyboardModeTracker } from "../src/keyboard-mode";
import { filterPickerItems } from "../src/picker";
import { extractPiAssistantText } from "../src/pi-completion-extension";
import { clearTerminalAttached, isTerminalAttached, markTerminalAttached } from "../src/presence";
import {
  controlSequenceIndex,
  findControlSequence,
  OUTER_TERMINAL_RESTORE,
  KITTY_SUBMIT_KEY,
  PASTE_SETTLE_QUIET_MS,
  sanitizePasteText,
  SUBMIT_KEY,
  terminalPaste,
  terminalReplacementPaste,
} from "../src/protocol";
import { classifyActivity, COMPLETION_GRACE_MS, OUTPUT_QUIET_MS, sessionActivity } from "../src/session-activity";
import { findRepository, FirstPromptCapture, sessionLabel } from "../src/session-metadata";
import { buildSpawnEnv, droppedEnvNames } from "../src/session-env";
import { CLOSED_PREVIEW_LIMIT, filterSessions, previewSessions, sessionSection } from "../src/session-menu";
import {
  compareSlackTs,
  loadSlackConfig,
  parseEnvFile,
  SlackApi,
  SlackRateLimitError,
  splitSlackMarkdown,
  withMention,
} from "../src/slack-api";
import {
  formatPollingRateLimitNotice,
  lastPostableCompletion,
  parseCompletionEvents,
  pollingPlan,
} from "../src/slack-bridge";
import { formatSlackThreadOpener } from "../src/slack-control";
import { readTerminalInput } from "../src/terminal-ui";
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

  it("wraps input as one bracketed paste without a trailing submit key", () => {
    expect(terminalPaste("one\ntwo")).toBe("\u001b[200~one\ntwo\u001b[201~");
    expect(terminalReplacementPaste("Slack prompt")).toBe("\u0015\u001b[200~Slack prompt\u001b[201~");
    // The submit key must not ride along in the paste: a harness that defers a
    // large paste absorbs it and the message is never sent.
    expect(terminalPaste("one\ntwo")).not.toContain(SUBMIT_KEY);
    expect(SUBMIT_KEY).toBe("\r");
    expect(PASTE_SETTLE_QUIET_MS).toBeGreaterThan(0);
    expect(KITTY_SUBMIT_KEY).toBe("\u001b[13u");
  });

  it("recognizes portable and managed-terminal detach sequences", () => {
    expect(controlSequenceIndex(Buffer.from([0x1d]))).toBe(0);
    expect(controlSequenceIndex(Buffer.from([0x1c]))).toBe(0);
    expect(controlSequenceIndex(Buffer.from("before\u001b[99~after"))).toBe(6);
    expect(controlSequenceIndex(Buffer.from("ordinary input"))).toBe(-1);
  });

  it("reports the summarize sequence with the length needed to keep the rest of the chunk", () => {
    const match = findControlSequence(Buffer.from("ab\u001b[98~cd"));
    expect(match).toEqual({ index: 2, length: 5, action: "summarize" });
    // The action decides whether the attachment survives, so the two managed
    // Ghostty bindings must not be collapsed into one another.
    expect(findControlSequence(Buffer.from("\u001b[99~"))?.action).toBe("slack");
  });

  it("restores terminal modes changed by a full-screen child", () => {
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[<1u");
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[?2004l");
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[?1049l");
    expect(OUTER_TERMINAL_RESTORE).toContain("\u001b[?25h");
    expect(OUTER_TERMINAL_RESTORE).toContain("\r\u001b[2K");
  });

  it("releases the keypress wait on the refresh timeout without stranding a listener", async () => {
    // A listener left behind would resolve a promise nobody awaits, so the menu
    // would silently swallow the next key the user pressed.
    const before = process.stdin.listenerCount("data");
    expect(await readTerminalInput(20)).toBeNull();
    expect(process.stdin.listenerCount("data")).toBe(before);
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

describe("keyboard mode", () => {
  it("stays in legacy mode for a session no terminal has attached to", () => {
    const tracker = new KeyboardModeTracker();
    tracker.consume("READY\r\n> ");
    expect(tracker.kittyKeyboardActive).toBe(false);
  });

  it("follows the pushes and pops the harness prints as it changes modes", () => {
    const tracker = new KeyboardModeTracker();
    tracker.consume("\u001b[>1u");
    expect(tracker.kittyKeyboardActive).toBe(true);
    tracker.consume("\u001b[<u");
    expect(tracker.kittyKeyboardActive).toBe(false);
  });

  it("reads the mode a real attached Claude Code session ended up in", () => {
    // Captured verbatim from a session whose Slack messages pasted but never
    // sent: the harness pops and re-pushes on every state change and is left
    // pushed, so a carriage return is not the key it is listening for.
    const tracker = new KeyboardModeTracker();
    for (let round = 0; round < 21; round += 1) tracker.consume("\u001b(B\u000f\u001b[<u\u001b[>1u\u001b[>4;2m");
    expect(tracker.kittyKeyboardActive).toBe(true);
  });

  it("survives a mode sequence split across two chunks of output", () => {
    const tracker = new KeyboardModeTracker();
    tracker.consume("some output\u001b[>");
    expect(tracker.kittyKeyboardActive).toBe(false);
    tracker.consume("1u more output");
    expect(tracker.kittyKeyboardActive).toBe(true);
  });

  it("treats explicitly zeroed flags as legacy reporting", () => {
    const tracker = new KeyboardModeTracker();
    tracker.consume("\u001b[>1u");
    tracker.consume("\u001b[=0;1u");
    expect(tracker.kittyKeyboardActive).toBe(false);
  });

  it("does not grow without bound when a harness never pops", () => {
    const tracker = new KeyboardModeTracker();
    for (let index = 0; index < 500; index += 1) tracker.consume("\u001b[>1u");
    expect(tracker.stack.length).toBeLessThanOrEqual(64);
    expect(tracker.kittyKeyboardActive).toBe(true);
  });

  it("ignores a stray escape instead of buffering output forever", () => {
    const tracker = new KeyboardModeTracker();
    tracker.consume("\u001b" + "x".repeat(500));
    expect(tracker.pending).toBe("");
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

  it("previews a bounded closed backlog without capping running sessions", () => {
    const running = [0, 1].map((index) =>
      session({ id: `run${String(index).padStart(9, "0")}`, status: "running" }),
    );
    const closed = Array.from({ length: CLOSED_PREVIEW_LIMIT + 11 }, (_unused, index) =>
      session({ id: `end${String(index).padStart(9, "0")}`, status: "ended" }),
    );

    const { visible, hiddenClosed } = previewSessions([...running, ...closed], "");
    expect(hiddenClosed).toBe(11);
    expect(visible).toHaveLength(running.length + CLOSED_PREVIEW_LIMIT);
    expect(visible.filter((item) => sessionSection(item) === "running")).toHaveLength(running.length);
    // The preview keeps the highest-ranked closed entries, which sort first.
    expect(visible.at(-1)?.id).toBe(closed[CLOSED_PREVIEW_LIMIT - 1]!.id);
  });

  it("reveals the whole closed history once a filter is active", () => {
    const closed = Array.from({ length: CLOSED_PREVIEW_LIMIT + 5 }, (_unused, index) =>
      session({ id: `end${String(index).padStart(9, "0")}`, status: "ended" }),
    );

    // A capped list the query cannot reach would strand these sessions.
    const { visible, hiddenClosed } = previewSessions(closed, "core codex");
    expect(hiddenClosed).toBe(0);
    expect(visible).toHaveLength(closed.length);
  });

  it("leaves a short closed backlog untouched", () => {
    const sessions = [session({ id: "111111111111", status: "running" }), session({ id: "222222222222", status: "ended" })];
    const { visible, hiddenClosed } = previewSessions(sessions, "");
    expect(hiddenClosed).toBe(0);
    expect(visible).toHaveLength(2);
  });

  it("fuzzy filters the harness picker by typed text", () => {
    const harnesses = ["Codex", "Kimi", "Pi", "Claude Code"];
    const filter = (query: string) => filterPickerItems(harnesses, (item) => item, query);

    expect(filter("")).toEqual(harnesses);
    expect(filter("kim")).toEqual(["Kimi"]);
    // Letters that navigate in the session menu must still filter here.
    expect(filter("k")).toEqual(["Kimi"]);
    expect(filter("cod")).toEqual(["Codex", "Claude Code"]);
    // Subsequence matching, not just prefixes.
    expect(filter("cc")).toEqual(["Claude Code"]);
    expect(filter("zzz")).toEqual([]);
  });

  it("previews closed sessions even when none are running", () => {
    const closed = Array.from({ length: CLOSED_PREVIEW_LIMIT + 3 }, (_unused, index) =>
      session({ id: `end${String(index).padStart(9, "0")}`, status: "ended" }),
    );
    const { visible, hiddenClosed } = previewSessions(closed, "");
    expect(hiddenClosed).toBe(3);
    expect(visible).toHaveLength(CLOSED_PREVIEW_LIMIT);
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
      // Two authorized users make the mention target ambiguous, so it stays unset.
      expect(config.notifyUserId).toBeNull();
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

  it("derives the mention target from a sole authorized user and honors an explicit override", async () => {
    const keys = [
      "AGENT_TUI_ENV_FILE",
      "SLACK_BOT_TOKEN_AGENT_COMMS",
      "SLACK_AGENT_COMMS_CHANNEL",
      "SLACK_AGENT_COMMS_ALLOWED_USERS",
      "SLACK_AGENT_COMMS_NOTIFY_USER",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.AGENT_TUI_ENV_FILE = join(tmpdir(), "agent-tui-absent-config-file");
      process.env.SLACK_BOT_TOKEN_AGENT_COMMS = "token";
      process.env.SLACK_AGENT_COMMS_CHANNEL = "channel";
      process.env.SLACK_AGENT_COMMS_ALLOWED_USERS = "U-solo";
      delete process.env.SLACK_AGENT_COMMS_NOTIFY_USER;
      expect((await loadSlackConfig("/repo")).notifyUserId).toBe("U-solo");

      // An explicit target wins even when the allowlist would have been usable.
      process.env.SLACK_AGENT_COMMS_NOTIFY_USER = "U-explicit";
      expect((await loadSlackConfig("/repo")).notifyUserId).toBe("U-explicit");

      process.env.SLACK_AGENT_COMMS_ALLOWED_USERS = "U-one,U-two";
      expect((await loadSlackConfig("/repo")).notifyUserId).toBe("U-explicit");
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("mentions only on the final chunk of a multi-chunk response", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const slack = new SlackApi("token", async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, ts: "123.456" });
    });

    await slack.postMarkdownMessage("channel", "alpha", "thread", "U-me");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("alpha\n\n<@U-me>");

    payloads.length = 0;
    const long = `${"a".repeat(12_500)}\n\nsecond paragraph`;
    await slack.postMarkdownMessage("channel", long, "thread", "U-me");
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.slice(0, -1).every(({ text }) => !String(text).includes("<@U-me>"))).toBe(true);
    expect(String(payloads.at(-1)?.text)).toEndWith("<@U-me>");
  });

  it("omits the mention when no target is configured", async () => {
    let payload: Record<string, unknown> | undefined;
    const slack = new SlackApi("token", async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, ts: "123.456" });
    });

    await slack.postMarkdownMessage("channel", "alpha", "thread", null);
    expect(payload?.text).toBe("alpha");
    expect(withMention("alpha", null)).toBe("alpha");
    expect(withMention("alpha", undefined)).toBe("alpha");
  });

  it("mentions once for a backlog that flushed after the terminal detached", () => {
    const pending = [
      { event: { type: "agent-turn-complete", "last-assistant-message": "one" }, nextOffset: 1 },
      { event: { type: "session-idle" }, nextOffset: 2 },
      { event: { type: "agent-turn-complete", "last-assistant-message": "two" }, nextOffset: 3 },
      // A completion with no text is never posted, so it cannot carry the mention.
      { event: { type: "agent-turn-complete", "last-assistant-message": "   " }, nextOffset: 4 },
    ];

    expect(lastPostableCompletion(pending)).toBe(2);
    expect(lastPostableCompletion([])).toBe(-1);
    expect(lastPostableCompletion([{ event: { type: "session-idle" }, nextOffset: 1 }])).toBe(-1);
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
  // The session daemon is spawned with `node` (node-pty emits no data under
  // Bun), and Node only strips types. Non-erasable syntax (parameter
  // properties, enums, namespaces) parses under Bun but crashes the daemon at
  // startup. The whole tree is checked because daemon.ts shares most modules.
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

describe("session activity", () => {
  const now = Date.parse("2026-08-06T12:00:00.000Z");

  it("holds a turn open until the harness reports it complete", () => {
    // A long tool call produces no output at all, so elapsed silence cannot
    // decide this; only the completion event closes the turn.
    const silentToolCall = { attached: false, outputAt: now - 90_000, completedAt: now - 120_000, now };
    expect(classifyActivity(silentToolCall)).toBe("working");
    expect(classifyActivity({ ...silentToolCall, completedAt: now - 1_000 })).toBe("idle");
  });

  it("absorbs the repaint that trails a completion event", () => {
    const trailing = { attached: false, outputAt: now - 60_000 + COMPLETION_GRACE_MS - 1, completedAt: now - 60_000, now };
    expect(classifyActivity(trailing)).toBe("idle");
    expect(classifyActivity({ ...trailing, outputAt: now - 60_000 + COMPLETION_GRACE_MS + 1 })).toBe("working");
  });

  it("falls back to recent output when no completion has ever been reported", () => {
    const noHook = { attached: false, completedAt: null, now };
    expect(classifyActivity({ ...noHook, outputAt: now - OUTPUT_QUIET_MS + 1 })).toBe("working");
    expect(classifyActivity({ ...noHook, outputAt: now - OUTPUT_QUIET_MS - 1 })).toBe("idle");
    expect(classifyActivity({ ...noHook, outputAt: null })).toBe("idle");
  });

  it("reports an attached session without consulting its echoed keystrokes", () => {
    expect(classifyActivity({ attached: true, outputAt: now, completedAt: null, now })).toBe("attached");
  });

  it("reads the live edges from the session log and completion events", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-activity-test-"));
    temporaryDirectories.push(home);
    const previousHome = process.env.AGENT_TUI_HOME;
    const previousRuntime = process.env.AGENT_TUI_RUNTIME;
    process.env.AGENT_TUI_HOME = home;
    process.env.AGENT_TUI_RUNTIME = join(home, "runtime");
    try {
      await ensureDirectories();
      const record = session({ id: "abcdef012345", logPath: join(home, "sessions", "abcdef012345.log") });
      expect(sessionActivity(record)).toBe("idle");

      await writeFile(record.logPath, "streaming output");
      expect(sessionActivity(record)).toBe("working");

      await writeFile(sessionEventsPath(record.id), '{"type":"agent-turn-complete"}\n');
      expect(sessionActivity(record)).toBe("idle");

      const settled = new Date(Date.now() - 60_000);
      await utimes(sessionEventsPath(record.id), settled, settled);
      expect(sessionActivity(record)).toBe("working");
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_TUI_HOME;
      else process.env.AGENT_TUI_HOME = previousHome;
      if (previousRuntime === undefined) delete process.env.AGENT_TUI_RUNTIME;
      else process.env.AGENT_TUI_RUNTIME = previousRuntime;
    }
  });
});

describe("session daemon", () => {
  it("submits in the encoding the harness announced, without trying the wrong one first", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-test-"));
    temporaryDirectories.push(home);
    const env = {
      AGENT_TUI_HOME: home,
      AGENT_TUI_RUNTIME: join(home, "runtime"),
      AGENT_TUI_ENV_PASSTHROUGH: "FIXTURE_ONLY_KITTY_SUBMIT,FIXTURE_ANNOUNCE_KITTY",
      FIXTURE_ONLY_KITTY_SUBMIT: "1",
      FIXTURE_ANNOUNCE_KITTY: "1",
    };
    const id = (await command(["run", "--detached", "--name", "announced", "--", process.execPath, FIXTURE], env)).trim();
    runningSessions.push({ id, env });
    await Bun.sleep(50);

    await command(["send", id, "--stdin"], env, "announced kitty harness");

    let capture = "";
    for (let attempt = 0; attempt < 160 && !capture.includes("RECEIVED:"); attempt += 1) {
      await Bun.sleep(25);
      capture = await command(["capture", id], env);
    }
    expect(capture).toContain("announced kitty harness");
    // The point of reading the mode off the harness output: it is submitted
    // first try, not after a carriage return has already been thrown away.
    expect(capture).toContain("SUBMITTED-BY:kitty");
    expect(capture).toContain("CR-IGNORED:0");
  });

  it("reports a message it could not get submitted instead of leaving it unsent", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-test-"));
    temporaryDirectories.push(home);
    const env = {
      AGENT_TUI_HOME: home,
      AGENT_TUI_RUNTIME: join(home, "runtime"),
      AGENT_TUI_ENV_PASSTHROUGH: "FIXTURE_IGNORE_SUBMIT",
      FIXTURE_IGNORE_SUBMIT: "1",
    };
    const id = (await command(["run", "--detached", "--name", "unsubmittable", "--", process.execPath, FIXTURE], env)).trim();
    runningSessions.push({ id, env });
    await Bun.sleep(50);

    await command(["send", id, "--stdin"], env, "nobody will ever submit this");

    // Silence is the whole hazard: without this event the sender is left
    // waiting on Slack for a reply that is never coming.
    let events = "";
    for (let attempt = 0; attempt < 200 && !events.includes("agent-submit-failed"); attempt += 1) {
      await Bun.sleep(25);
      events = await readFile(join(home, "sessions", id + ".events.jsonl"), "utf8").catch(() => "");
    }
    expect(events).toContain("agent-submit-failed");
    expect(events).toContain("nobody will ever submit this");
  });

  it("falls back to the Kitty keyboard enter when carriage returns do nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-test-"));
    temporaryDirectories.push(home);
    const env = {
      AGENT_TUI_HOME: home,
      AGENT_TUI_RUNTIME: join(home, "runtime"),
      AGENT_TUI_ENV_PASSTHROUGH: "FIXTURE_ONLY_KITTY_SUBMIT",
      FIXTURE_ONLY_KITTY_SUBMIT: "1",
    };
    const id = (await command(["run", "--detached", "--name", "kitty", "--", process.execPath, FIXTURE], env)).trim();
    runningSessions.push({ id, env });
    await Bun.sleep(50);

    await command(["send", id, "--stdin"], env, "kitty only harness");

    let capture = "";
    for (let attempt = 0; attempt < 160 && !capture.includes("RECEIVED:"); attempt += 1) {
      await Bun.sleep(25);
      capture = await command(["capture", id], env);
    }
    expect(capture).toContain("kitty only harness");
  });

  it("resends the submit key when the harness silently drops it", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-tui-test-"));
    temporaryDirectories.push(home);
    const env = {
      AGENT_TUI_HOME: home,
      AGENT_TUI_RUNTIME: join(home, "runtime"),
      AGENT_TUI_ENV_PASSTHROUGH: "FIXTURE_DROP_FIRST_SUBMIT",
      FIXTURE_DROP_FIRST_SUBMIT: "1",
    };
    const id = (await command(["run", "--detached", "--name", "dropped", "--", process.execPath, FIXTURE], env)).trim();
    runningSessions.push({ id, env });
    await Bun.sleep(50);

    await command(["send", id, "--stdin"], env, "please answer this");

    // The fixture swallows the first enter and emits nothing, exactly as a
    // harness that loses the key does. Only the retry can land the message.
    let capture = "";
    for (let attempt = 0; attempt < 160 && !capture.includes("RECEIVED:"); attempt += 1) {
      await Bun.sleep(25);
      capture = await command(["capture", id], env);
    }
    expect(capture).toContain("RECEIVED:");
    expect(capture).toContain("please answer this");
  });

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
    // The submit key deliberately lands SUBMIT_DELAY_MS after the paste, so wait
    // for the child to echo the delivered line rather than racing a fixed sleep.
    let capture = "";
    for (let attempt = 0; attempt < 160 && !capture.includes("RECEIVED:"); attempt += 1) {
      await Bun.sleep(25);
      capture = await command(["capture", id], env);
    }

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

describe("spawn environment", () => {
  it("drops application secrets while keeping what a session needs to run", () => {
    const env = buildSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      TERM: "xterm-256color",
      FNM_DIR: "/Users/example/.fnm",
      AGENT_TUI_HOME: "/state",
      // The leak this allowlist exists to stop: a repo .env inherited from
      // whatever shell happened to start the daemon.
      DATABASE_URL: "postgres://user:pw@host/db",
      RAILWAY_API_TOKEN: "token",
      BETTER_AUTH_SECRET: "secret",
      GOOGLE_CLIENT_SECRET: "secret",
      QBO_TOKEN_KEY: "key",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/example");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.FNM_DIR).toBe("/Users/example/.fnm");
    expect(env.AGENT_TUI_HOME).toBe("/state");

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.RAILWAY_API_TOKEN).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(env.QBO_TOKEN_KEY).toBeUndefined();
  });

  it("applies overrides unconditionally", () => {
    const env = buildSpawnEnv({ PATH: "/usr/bin" }, { AGENT_TUI_SESSION_ID: "abc" });
    expect(env.AGENT_TUI_SESSION_ID).toBe("abc");
  });

  it("honors the passthrough escape hatch without widening the default", () => {
    const source = { PATH: "/usr/bin", CUSTOM_THING: "value" };
    expect(buildSpawnEnv(source).CUSTOM_THING).toBeUndefined();

    const widened = buildSpawnEnv({ ...source, AGENT_TUI_ENV_PASSTHROUGH: "CUSTOM_THING" });
    expect(widened.CUSTOM_THING).toBe("value");
  });

  it("reports what it dropped", () => {
    expect(droppedEnvNames({ PATH: "/usr/bin", DATABASE_URL: "x" })).toEqual(["DATABASE_URL"]);
  });
});
