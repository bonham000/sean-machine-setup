/**
 * Install the slack-agent-comms daemon as a launchd LaunchAgent on macOS.
 *
 * Steps:
 *   1. `bun build src/index.ts` → <home>/.claude/agent-comms/dist/index.js
 *   2. Stage the configured/core-repo .env → <home>/.claude/agent-comms/.env
 *   3. Render src/daemon/launchd.plist.tmpl with {HOME}/{BUN_PATH} substitutions
 *   4. Write to <home>/Library/LaunchAgents/com.priori.agent-comms.plist
 *   5. Install templates/claude-commands/slack-attach-session.md → <home>/.claude/commands/
 *   6. Install CLI symlink at <home>/.local/bin/agent-comms → src/cli/index.ts
 *   7. launchctl bootstrap (or load) and verify (skipped with --no-load)
 *
 * Idempotent: re-running upgrades dist + plist + .env in place. The
 * registry sqlite at <home>/.claude/agent-comms/registry.db is never touched.
 *
 * Usage:
 *   bun scripts/install.ts                       # build + install + load
 *   bun scripts/install.ts --no-load             # skip launchctl, just stage files
 *   bun scripts/install.ts --home <path> --no-load  # test mode: use temp home
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export const HERE = dirname(new URL(import.meta.url).pathname);
export const PKG_ROOT = join(HERE, '..');
export const PLIST_LABEL = 'com.priori.agent-comms';
export const OLD_PLIST_LABEL = 'com.priori.handoff';

export async function buildDist(distDir: string): Promise<void> {
  mkdirSync(distDir, { recursive: true });
  const stagedDir = `${distDir}.staging-${process.pid}-${crypto.randomUUID()}`;
  const stagedEntry = join(stagedDir, 'index.js');
  const installedEntry = join(distDir, 'index.js');
  console.log(`[install] building → ${installedEntry}`);

  try {
    const result = await Bun.build({
      entrypoints: [join(PKG_ROOT, 'src', 'index.ts')],
      outdir: stagedDir,
      target: 'bun',
      naming: 'index.js',
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error('bun build failed');
    }
    if (!existsSync(stagedEntry)) {
      throw new Error(`bun build did not produce ${stagedEntry}`);
    }

    // Same-filesystem rename keeps the installed entrypoint wholly old or
    // wholly new; a failed build never leaves launchd a partial bundle.
    renameSync(stagedEntry, installedEntry);
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
  }
}

export function resolveEnvSource(home: string): string {
  const configured = process.env.AGENT_COMMS_ENV_FILE;
  const candidates = [
    configured,
    join(home, 'Documents', 'core-repo', '.env'),
    join(home, '.config', 'agent-comms', '.env'),
  ].filter((path): path is string => Boolean(path));
  const source = candidates.find((path) => existsSync(path));
  if (source) return source;

  throw new Error(
    `No agent-comms environment file found. Checked:\n${candidates.map((path) => `  - ${path}`).join('\n')}\nLoad credentials with \`task -d ~/Documents/core-repo secrets:load\`, then retry the original command, or set AGENT_COMMS_ENV_FILE.`,
  );
}

export function stageEnv(botDir: string, home: string): void {
  const src = resolveEnvSource(home);
  const dst = join(botDir, '.env');
  mkdirSync(botDir, { recursive: true });
  copyFileSync(src, dst);
  chmodSync(dst, 0o600);
  console.log(`[install] staged .env → ${dst}`);
}

export function renderPlist(
  home: string,
  plistPath: string,
  logDir: string,
): void {
  const tmplPath = join(PKG_ROOT, 'src', 'daemon', 'launchd.plist.tmpl');
  const bunPath = process.execPath;
  const user = process.env.USER ?? process.env.LOGNAME ?? 'user';
  const shell = process.env.SHELL ?? '/bin/zsh';
  const tmpl = readFileSync(tmplPath, 'utf8');
  const rendered = tmpl
    .replaceAll('{HOME}', home)
    .replaceAll('{BUN_PATH}', bunPath)
    .replaceAll('{USER}', user)
    .replaceAll('{SHELL}', shell);
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plistPath, rendered, 'utf8');
  console.log(`[install] wrote ${plistPath}`);
}

export function installSlashCommand(commandsDir: string): void {
  mkdirSync(commandsDir, { recursive: true });

  const src = join(
    PKG_ROOT,
    'templates',
    'claude-commands',
    'slack-attach-session.md',
  );
  const dst = join(commandsDir, 'slack-attach-session.md');
  copyFileSync(src, dst);
  console.log(`[install] installed slash command → ${dst}`);
}

export function installCLIBinary(binDir: string): void {
  mkdirSync(binDir, { recursive: true });

  const cliSource = join(PKG_ROOT, 'src', 'cli', 'index.ts');
  const symlinkPath = join(binDir, 'agent-comms');

  // Make the CLI source executable
  chmodSync(cliSource, 0o755);

  // lstat sees dangling symlinks; existsSync follows them and would miss an
  // old link whose target moved when agent-comms migrated out of core-repo.
  try {
    const existing = lstatSync(symlinkPath);
    if (existing.isDirectory()) {
      throw new Error(`Refusing to replace directory at ${symlinkPath}`);
    }
    unlinkSync(symlinkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  symlinkSync(cliSource, symlinkPath);
  console.log(`[install] installed CLI symlink ${symlinkPath} → ${cliSource}`);
}

export async function loadDaemon(
  home: string,
  plistPath: string,
): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  const target = `gui/${uid}`;

  // Best-effort bootout of stale old label
  const oldPlistPath = join(
    home,
    'Library',
    'LaunchAgents',
    `${OLD_PLIST_LABEL}.plist`,
  );
  if (existsSync(oldPlistPath)) {
    await Bun.spawn(['launchctl', 'bootout', target, oldPlistPath], {
      stderr: 'ignore',
      stdout: 'ignore',
    }).exited;
    try {
      unlinkSync(oldPlistPath);
      console.log(`[install] removed stale plist ${oldPlistPath}`);
    } catch {
      // best-effort
    }
  } else {
    // Try bootout by label even without plist
    await Bun.spawn(
      ['launchctl', 'bootout', target, `${target}/${OLD_PLIST_LABEL}`],
      {
        stderr: 'ignore',
        stdout: 'ignore',
      },
    ).exited;
  }

  // Bootout current label first to handle re-installs cleanly; ignore failure.
  await Bun.spawn(['launchctl', 'bootout', target, plistPath], {
    stderr: 'ignore',
    stdout: 'ignore',
  }).exited;

  const boot = Bun.spawn(['launchctl', 'bootstrap', target, plistPath], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const bootCode = await boot.exited;
  if (bootCode !== 0) {
    const stderr = await new Response(boot.stderr).text();
    throw new Error(`launchctl bootstrap failed (exit ${bootCode}): ${stderr}`);
  }

  await Bun.spawn(
    ['launchctl', 'kickstart', '-k', `${target}/${PLIST_LABEL}`],
    { stderr: 'ignore', stdout: 'ignore' },
  ).exited;

  const list = Bun.spawn(['launchctl', 'list'], { stdout: 'pipe' });
  await list.exited;
  const text = await new Response(list.stdout).text();
  const found = text.split('\n').filter((l) => l.includes(PLIST_LABEL));
  if (found.length === 0) {
    throw new Error(
      `launchctl list does not show ${PLIST_LABEL} after bootstrap`,
    );
  }
  console.log(`[install] launchd loaded:\n  ${found.join('\n  ')}`);
}

export async function install(opts: {
  home: string;
  noLoad?: boolean;
}): Promise<void> {
  const home = opts.home;
  const botDir = join(home, '.claude', 'agent-comms');
  const distDir = join(botDir, 'dist');
  const logDir = join(botDir, 'logs');
  const commandsDir = join(home, '.claude', 'commands');
  const binDir = join(home, '.local', 'bin');
  const plistPath = join(
    home,
    'Library',
    'LaunchAgents',
    `${PLIST_LABEL}.plist`,
  );

  // 1. Build daemon dist
  await buildDist(distDir);

  // 2. Stage .env
  stageEnv(botDir, home);

  // 3–4. Render and write plist
  renderPlist(home, plistPath, logDir);

  // 5. Install slash command
  installSlashCommand(commandsDir);

  // 6. Install CLI binary symlink
  installCLIBinary(binDir);

  // 7. Load daemon
  if (opts.noLoad) {
    console.log('[install] --no-load passed — skipping launchctl load');
    return;
  }
  await loadDaemon(home, plistPath);
  console.log(
    `[install] done. Logs at ${logDir}/stdout.log and ${logDir}/stderr.log`,
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'no-load': { type: 'boolean', default: false },
      home: { type: 'string' },
    },
    strict: true,
  });

  install({ home: values.home ?? homedir(), noLoad: values['no-load'] }).catch(
    (err) => {
      console.error(`[install] FAILED: ${err.message ?? err}`);
      process.exit(1);
    },
  );
}
