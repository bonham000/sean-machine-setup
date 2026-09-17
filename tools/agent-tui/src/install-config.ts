#!/usr/bin/env bun

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./adapters";
import { parseEnvFile } from "./slack-api";

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG_KEYS = [
  "SLACK_BOT_TOKEN_AGENT_COMMS",
  "SLACK_AGENT_COMMS_CHANNEL",
  "SLACK_AGENT_COMMS_ALLOWED_USERS",
] as const;

type InstallConfigOptions = {
  home?: string;
  coreRepo?: string;
  loadVault?: (coreRepo: string) => Promise<void> | void;
};

function refreshCoreRepoEnvironment(coreRepo: string): void {
  const result = Bun.spawnSync(["task", "secrets:load"], {
    cwd: coreRepo,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Unable to refresh ${coreRepo}/.env from the Priori secrets vault`);
  }
}

export async function installAgentTuiConfig(options: InstallConfigOptions = {}): Promise<string> {
  const home = options.home ?? homedir();
  const coreRepo = options.coreRepo ?? process.env.AGENT_TUI_CORE_REPO ?? join(home, "Documents", "core-repo");
  await (options.loadVault ?? refreshCoreRepoEnvironment)(coreRepo);

  const source = join(coreRepo, ".env");
  const sourceValues = parseEnvFile(await readFile(source, "utf8"));
  const missing = CONFIG_KEYS.filter((key) => !sourceValues[key]);
  if (missing.length > 0) {
    throw new Error(`Vault-loaded ${source} is missing: ${missing.join(", ")}`);
  }

  const invalid = CONFIG_KEYS.filter((key) => /[\r\n]/.test(sourceValues[key]!));
  if (invalid.length > 0) {
    throw new Error(`Refusing multiline agent-tui configuration values: ${invalid.join(", ")}`);
  }

  const configDirectory = join(home, ".config", "agent-tui");
  const destination = join(configDirectory, ".env");
  const temporary = join(configDirectory, `.env.${process.pid}.tmp`);
  const body = [
    "# Generated from the Priori secrets vault by task agent-tui:setup.",
    ...CONFIG_KEYS.map((key) => `${key}=${sourceValues[key]}`),
    "",
  ].join("\n");

  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

// Kimi has no launch-scoped way to register a completion hook (config file
// only), so the Stop hook that feeds detached-session Slack forwarding is
// reconciled into the Kimi config here instead of injected per launch like
// the Claude, Codex, and Pi adapters. The short timeout matters: Stop hooks
// run inside the turn, and a slow one holds the turn open.
const KIMI_HOOK_TIMEOUT_SECONDS = 5;

export function kimiHookBlock(command: string): string {
  return [
    "[[hooks]]",
    "# Managed by agent-tui (task agent-tui:setup). Forwards detached Kimi",
    "# session responses to Slack; harmless for sessions agent-tui does not own.",
    'event = "Stop"',
    `command = ${JSON.stringify(command)}`,
    `timeout = ${KIMI_HOOK_TIMEOUT_SECONDS}`,
    "",
  ].join("\n");
}

export function reconcileKimiHookConfig(config: string, block: string): string {
  // TOML has no dependency-free editor here, so work section by section:
  // drop any previously managed Stop-hook block (identified by the hook
  // script name, so upgrades that move the script still replace it), keep
  // every user section untouched, and append the current block.
  const sections = config.split(/(?=^\[)/m);
  const kept = sections.filter(
    (section) => !(section.startsWith("[[hooks]]") && section.includes("kimi-completion-hook")),
  );
  const body = kept.join("").replace(/\s*$/, "");
  return body ? `${body}\n\n${block}` : block;
}

export type InstallKimiHookOptions = {
  home?: string;
  runtime?: string;
  hookPath?: string;
};

export async function installKimiHookConfig(options: InstallKimiHookOptions = {}): Promise<string> {
  const kimiHome = options.home ? join(options.home, ".kimi-code") : (process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"));
  const runtime = options.runtime ?? process.execPath;
  const hookPath = options.hookPath ?? join(HERE, "kimi-completion-hook.ts");
  const block = kimiHookBlock(`${shellQuote(runtime)} ${shellQuote(hookPath)}`);

  const destination = join(kimiHome, "config.toml");
  let existing = "";
  let mode = 0o600;
  try {
    existing = await readFile(destination, "utf8");
    mode = (await stat(destination)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const reconciled = reconcileKimiHookConfig(existing, block);
  if (reconciled !== existing) {
    await mkdir(kimiHome, { recursive: true, mode: 0o700 });
    const temporary = join(kimiHome, `.config.toml.${process.pid}.tmp`);
    try {
      await writeFile(temporary, reconciled, { encoding: "utf8", mode });
      await chmod(temporary, mode);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return destination;
}

if (import.meta.main) {
  try {
    const destination = await installAgentTuiConfig();
    process.stdout.write(`Installed private agent-tui configuration at ${destination}\n`);
    const kimiConfig = await installKimiHookConfig();
    process.stdout.write(`Installed Kimi completion hook in ${kimiConfig}\n`);
  } catch (error) {
    process.stderr.write(`agent-tui config installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
