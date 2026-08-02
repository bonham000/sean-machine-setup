import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function missingCredentialEnvError(missing: readonly string[]): string {
  const names = [...missing].sort().join(', ');
  return [
    `Missing credential environment variable${missing.length === 1 ? '' : 's'}: ${names}.`,
    'Load the repository credentials from the Priori secrets vault with `task -d ~/Documents/core-repo secrets:load`, then retry the original command.',
    'Do not treat missing local environment variables as unavailable credentials until vault loading has been attempted.',
  ].join('\n');
}

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(missingCredentialEnvError([key]));
  return val;
}

function optional(key: string, fallback: string): string {
  const val = process.env[key];
  return val && val.length > 0 ? val : fallback;
}

/**
 * Resolve MACHINE_ID with a fallback chain so the daemon doesn't show
 * `unknown` after a fresh install where the staged .env didn't carry it:
 *   1. process.env.MACHINE_ID (the canonical source when env:setup ran)
 *   2. ~/.AGENT_MACHINE_IDENTITY (the canonical machine-identity hub —
 *      a SessionStart hook reads the same file into CC sessions)
 *   3. literal "unknown"
 *
 * `home` is injectable so tests can point at a temp dir; production callers
 * leave it unset and we read from `homedir()`. Cached `os.homedir()` ignores
 * runtime `HOME` mutations on macOS, so this seam is the only sane way to
 * unit-test the fallback chain.
 */
export function resolveMachineId(home?: string): string {
  const fromEnv = process.env.MACHINE_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const path = join(home ?? homedir(), '.AGENT_MACHINE_IDENTITY');
    if (existsSync(path)) {
      const body = readFileSync(path, 'utf8');
      const match = body.match(/^MACHINE_ID=(.+)$/m);
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    /* best-effort — fall through to "unknown" */
  }
  return 'unknown';
}

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackAgentCommsChannel: string;
  slackAllowedUsers: Set<string>;
  machineId: string;
  port: number;
  /** cwd used to spawn fresh sessions started via @-mention. */
  defaultMentionCwd: string;
}

export function loadConfig(): Config {
  const allowedRaw = required('SLACK_AGENT_COMMS_ALLOWED_USERS');
  const allowed = new Set(
    allowedRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (allowed.size === 0) {
    throw new Error(
      `${missingCredentialEnvError(['SLACK_AGENT_COMMS_ALLOWED_USERS'])}\nThe value must contain at least one Slack user ID.`,
    );
  }
  return {
    slackBotToken: required('SLACK_BOT_TOKEN_AGENT_COMMS'),
    slackAppToken: required('SLACK_APP_TOKEN_AGENT_COMMS'),
    slackAgentCommsChannel: required('SLACK_AGENT_COMMS_CHANNEL'),
    slackAllowedUsers: allowed,
    machineId: resolveMachineId(),
    port: Number(optional('AGENT_COMMS_PORT', '42100')),
    defaultMentionCwd: optional(
      'AGENT_COMMS_DEFAULT_CWD',
      join(homedir(), 'Documents', 'core-repo'),
    ),
  };
}
