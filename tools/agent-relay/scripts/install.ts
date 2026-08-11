import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export const LABEL = 'com.priori.agent-relay';
export const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

export function renderPlist(home: string, bunPath = process.execPath): string {
  const template = readFileSync(join(ROOT, 'src', 'daemon', 'launchd.plist.tmpl'), 'utf8');
  return template
    .replaceAll('{HOME}', home)
    .replaceAll('{BUN_PATH}', bunPath)
    .replaceAll('{USER}', process.env.USER ?? process.env.LOGNAME ?? 'user')
    .replaceAll('{SHELL}', process.env.SHELL ?? '/bin/zsh');
}

export function installPlist(home: string, bunPath = process.execPath): string {
  const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(home, '.claude', 'agent-relay', 'logs'), { recursive: true });
  writeFileSync(path, renderPlist(home, bunPath));
  return path;
}

export async function loadDaemon(path: string): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await Bun.spawn(['launchctl', 'bootout', domain, path], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exited;
  const boot = Bun.spawn(['launchctl', 'bootstrap', domain, path], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await boot.exited) !== 0)
    throw new Error(`launchctl bootstrap failed: ${await new Response(boot.stderr).text()}`);
  await Bun.spawn(['launchctl', 'kickstart', '-k', `${domain}/${LABEL}`]).exited;
}

export async function install(options: { home: string; noLoad?: boolean; noStage?: boolean }): Promise<void> {
  const core = join(options.home, 'Documents', 'core-repo');
  if (!options.noStage) {
    if (!existsSync(core)) throw new Error(`core-repo not found: ${core}`);
    const dependencies = Bun.spawn(
      [process.execPath, 'install', '--frozen-lockfile'],
      {
        cwd: core,
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await dependencies.exited) !== 0)
      throw new Error('core-repo dependency install failed');
    const stage = Bun.spawn(['task', 'agents:stage', '--', 'relay'], {
      cwd: core,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await stage.exited) !== 0) throw new Error('Relay staging failed');
  }
  const path = installPlist(options.home);
  if (!options.noLoad) await loadDaemon(path);
  console.log(`Installed ${LABEL} at ${path}`);
}

if (import.meta.main) {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      home: { type: 'string', default: homedir() },
      'no-load': { type: 'boolean', default: false },
      'no-stage': { type: 'boolean', default: false },
    },
  });
  await install({
    home: parsed.values.home,
    noLoad: parsed.values['no-load'],
    noStage: parsed.values['no-stage'],
  });
}
