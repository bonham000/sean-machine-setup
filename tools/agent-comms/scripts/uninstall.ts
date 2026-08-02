/**
 * Uninstall the slack-agent-comms launchd LaunchAgent.
 *
 * Stops and removes the com.priori.agent-comms plist. Also performs a
 * best-effort bootout of the legacy com.priori.handoff plist if still present.
 * Does NOT delete the registry sqlite, dist artifact, .env, or logs — those
 * persist across uninstall/reinstall so agent-comms threads remain reusable.
 *
 * Usage:
 *   bun scripts/uninstall.ts
 */

import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const PLIST_LABEL = 'com.priori.agent-comms';
const OLD_PLIST_LABEL = 'com.priori.handoff';
const PLIST_PATH = join(
  HOME,
  'Library',
  'LaunchAgents',
  `${PLIST_LABEL}.plist`,
);
const OLD_PLIST_PATH = join(
  HOME,
  'Library',
  'LaunchAgents',
  `${OLD_PLIST_LABEL}.plist`,
);

async function bootout(
  target: string,
  plistPath: string,
  label: string,
): Promise<void> {
  if (existsSync(plistPath)) {
    const proc = Bun.spawn(['launchctl', 'bootout', target, plistPath], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(
        `[uninstall] launchctl bootout ${label} exit=${code} (often fine if not loaded): ${stderr.trim()}`,
      );
    } else {
      console.log(`[uninstall] launchctl bootout ${label} ok`);
    }
    unlinkSync(plistPath);
    console.log(`[uninstall] removed ${plistPath}`);
  } else {
    // Try bootout by label even without plist, best-effort
    await Bun.spawn(['launchctl', 'bootout', target, `${target}/${label}`], {
      stderr: 'ignore',
      stdout: 'ignore',
    }).exited;
  }
}

async function main(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  const target = `gui/${uid}`;

  // Unload current label
  if (existsSync(PLIST_PATH)) {
    await bootout(target, PLIST_PATH, PLIST_LABEL);
  } else {
    console.log(
      `[uninstall] no plist at ${PLIST_PATH}; nothing to do for ${PLIST_LABEL}`,
    );
  }

  // Best-effort cleanup of legacy label
  if (existsSync(OLD_PLIST_PATH)) {
    console.log(
      `[uninstall] found stale legacy plist ${OLD_PLIST_PATH}; removing`,
    );
    await bootout(target, OLD_PLIST_PATH, OLD_PLIST_LABEL);
  } else {
    // Try bootout by label anyway, silently
    await Bun.spawn(
      ['launchctl', 'bootout', target, `${target}/${OLD_PLIST_LABEL}`],
      {
        stderr: 'ignore',
        stdout: 'ignore',
      },
    ).exited;
  }

  console.log('[uninstall] done. ~/.claude/agent-comms/ preserved.');
}

main().catch((err) => {
  console.error(`[uninstall] FAILED: ${err.message ?? err}`);
  process.exit(1);
});

