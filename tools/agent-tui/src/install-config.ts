#!/usr/bin/env bun

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "./slack-api";

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

if (import.meta.main) {
  try {
    const destination = await installAgentTuiConfig();
    process.stdout.write(`Installed private agent-tui configuration at ${destination}\n`);
  } catch (error) {
    process.stderr.write(`agent-tui config installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
