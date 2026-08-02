/**
 * Set up machine identity on this machine.
 *
 * The user works across multiple machines (MacBook Pro, Mac Mini) with identical
 * repo family setups. CC sessions on either machine should know which one
 * they're on so they can reason about delegation, AFK behavior, and the cost
 * of long-running tasks (e.g. a 2-hour SCK recording on the MBP locks the user
 * out, but on the Mini it's a fine AFK job).
 *
 * This script:
 *   1. Copies the canonical identity file from
 *      `sean-machine-setup/config/machine-identities/<machine>.env` to
 *      `~/.AGENT_MACHINE_IDENTITY` on the current machine.
 *   2. Patches `~/.claude/settings.json` to register a SessionStart hook
 *      that `cat`s that file into the session's context on every
 *      startup/resume/clear/compact event.
 *
 * Net effect: every CC session on this machine sees the machine identity
 * block as injected context. No reading required, no remembering.
 *
 * Idempotent: re-running with no changes is a no-op. Re-running with a
 * different `--machine` overwrites both the identity file and any prior
 * SessionStart hook entries this script previously installed (other entries
 * in `hooks.SessionStart` are preserved).
 *
 * Usage:
 *   bun scripts/setup-machine-identity.ts --machine mbp
 *   bun scripts/setup-machine-identity.ts --machine mac-mini
 *   bun scripts/setup-machine-identity.ts --machine mbp --dry-run
 *   bun scripts/setup-machine-identity.ts --list           # show available
 *   bun scripts/setup-machine-identity.ts --machine mbp --json
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dir, '..');
const IDENTITIES_DIR = join(ROOT, 'config', 'machine-identities');
const HOME = homedir();
const IDENTITY_TARGET = join(HOME, '.AGENT_MACHINE_IDENTITY');
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json');

const HOOK_COMMAND = 'cat ~/.AGENT_MACHINE_IDENTITY';
// Claude Code SessionStart matchers:
//   startup — fresh session
//   resume  — `claude --resume` or similar
//   clear   — after `/clear`
//   compact — after auto/manual compaction
// Register all four so identity context is present in every state.
const HOOK_MATCHERS = ['startup', 'resume', 'clear', 'compact'] as const;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    machine: { type: 'string', short: 'm' },
    'dry-run': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
  strict: true,
});

const dryRun = values['dry-run'];
const jsonOut = values.json;

function listAvailable(): string[] {
  if (!existsSync(IDENTITIES_DIR)) return [];
  return readdirSync(IDENTITIES_DIR)
    .filter((f) => f.endsWith('.env'))
    .map((f) => f.replace(/\.env$/, ''))
    .sort();
}

if (values.list) {
  const ids = listAvailable();
  if (jsonOut) {
    console.log(JSON.stringify({ identities: ids }, null, 2));
  } else {
    console.log('Available machine identities:');
    for (const id of ids) console.log(`  - ${id}`);
  }
  process.exit(0);
}

if (!values.machine) {
  const ids = listAvailable();
  console.error('Error: --machine is required.');
  console.error(`Available: ${ids.join(', ') || '(none)'}`);
  console.error('Run with --list for details.');
  process.exit(1);
}

const machine = values.machine;
const identitySource = join(IDENTITIES_DIR, `${machine}.env`);

if (!existsSync(identitySource)) {
  const ids = listAvailable();
  console.error(`Error: identity '${machine}' not found at ${identitySource}`);
  console.error(`Available: ${ids.join(', ') || '(none)'}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build plan
// ---------------------------------------------------------------------------

type SessionStartEntry = {
  matcher?: string;
  hooks: { type: string; command: string }[];
};

type SettingsShape = {
  hooks?: {
    SessionStart?: SessionStartEntry[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

function loadSettings(): SettingsShape | null {
  if (!existsSync(SETTINGS_PATH)) return null;
  const raw = readFileSync(SETTINGS_PATH, 'utf-8');
  if (!raw.trim()) return null;
  return JSON.parse(raw) as SettingsShape;
}

function buildSettingsAfter(current: SettingsShape | null): SettingsShape {
  const next: SettingsShape = current ? { ...current } : {};
  const nextHooks = { ...(next.hooks ?? {}) };
  const existingSessionStart: SessionStartEntry[] = Array.isArray(
    nextHooks.SessionStart,
  )
    ? [...nextHooks.SessionStart]
    : [];

  // Drop any prior entries that match our marker (command === HOOK_COMMAND).
  // Preserve everything else so we play nice with other hooks.
  const otherEntries = existingSessionStart.filter((entry) => {
    const cmds = Array.isArray(entry?.hooks) ? entry.hooks : [];
    return !cmds.some((h) => h?.command === HOOK_COMMAND);
  });

  const ourEntries: SessionStartEntry[] = HOOK_MATCHERS.map((matcher) => ({
    matcher,
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  }));

  nextHooks.SessionStart = [...otherEntries, ...ourEntries];
  next.hooks = nextHooks;
  return next;
}

const newIdentityContent = readFileSync(identitySource, 'utf-8');
const currentIdentityContent = existsSync(IDENTITY_TARGET)
  ? readFileSync(IDENTITY_TARGET, 'utf-8')
  : null;

type Action = 'create' | 'update' | 'noop';

const identityAction: Action =
  currentIdentityContent === null
    ? 'create'
    : currentIdentityContent === newIdentityContent
      ? 'noop'
      : 'update';

const currentSettings = loadSettings();
const newSettings = buildSettingsAfter(currentSettings);

const settingsAction: Action =
  currentSettings === null
    ? 'create'
    : JSON.stringify(currentSettings) === JSON.stringify(newSettings)
      ? 'noop'
      : 'update';

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

if (!dryRun) {
  if (identityAction !== 'noop') {
    copyFileSync(identitySource, IDENTITY_TARGET);
  }
  if (settingsAction !== 'noop') {
    const settingsDir = dirname(SETTINGS_PATH);
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true });
    }
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(newSettings, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const summary = {
  machine,
  identity: { path: IDENTITY_TARGET, action: identityAction },
  settings: { path: SETTINGS_PATH, action: settingsAction },
  hookMatchers: [...HOOK_MATCHERS],
  hookCommand: HOOK_COMMAND,
  dryRun,
};

if (jsonOut) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Machine identity: ${machine}`);
  console.log(`  Source:        ${identitySource}`);
  console.log(`  Identity file: ${IDENTITY_TARGET} — ${identityAction}`);
  console.log(`  Settings hook: ${SETTINGS_PATH} — ${settingsAction}`);
  console.log(
    `  Hook matchers: ${HOOK_MATCHERS.join(', ')} (cmd: \`${HOOK_COMMAND}\`)`,
  );
  if (dryRun) {
    console.log('\n(dry run — no files written)');
  }
  if (identityAction === 'noop' && settingsAction === 'noop') {
    console.log('\nAlready up to date.');
  } else if (!dryRun) {
    console.log('\nIdentity file contents now installed:');
    console.log('---');
    console.log(newIdentityContent.trimEnd());
    console.log('---');
    console.log(
      '\nMachine identity will be auto-injected into every new CC session.',
    );
  }
}
