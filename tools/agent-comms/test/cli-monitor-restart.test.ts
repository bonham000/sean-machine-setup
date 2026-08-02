/**
 * Real CLI restart coverage for agent-comms monitor.
 *
 * The daemon allows same-owner reconnects, but that only helps if the CLI uses
 * a stable owner token across process restarts. This test runs the actual CLI
 * against a real Bun.serve daemon, kills it, immediately restarts it inside the
 * stale window, and asserts the replacement stays alive instead of exiting 7.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveHttpApp } from '../src/http/serve';
import { createHttpApp } from '../src/http/server';
import { createDurableRegistry, type DurableRegistry } from '../src/registry';
import { ensureSecret } from '../src/secret';
import { makeServerDeps, waitFor } from './fakes/deps';
import { createFakeSlackClient } from './fakes/slack';

const CLI = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const CHANNEL = 'C_CLI_RESTART';
const MACHINE = 'test-machine';

let tmpHome: string;
let originalHome: string | undefined;
let tmpDir: string;
let registry: DurableRegistry;
let server: ReturnType<typeof Bun.serve>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnMonitor(attachmentId: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      'bun',
      CLI,
      'monitor',
      '--attachment',
      attachmentId,
      '--port',
      String(server.port),
    ],
    {
      env: { ...process.env, HOME: tmpHome },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'cli-monitor-restart-home-'));
  process.env.HOME = tmpHome;
  ensureSecret();

  tmpDir = mkdtempSync(join(tmpdir(), 'cli-monitor-restart-'));
  registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
  const fake = createFakeSlackClient();
  const app = createHttpApp(
    makeServerDeps(registry, fake, { channelId: CHANNEL, machineId: MACHINE }),
  );

  server = serveHttpApp({ app, port: 0 });
});

afterAll(async () => {
  server?.stop(true);
  await sleep(250);
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('agent-comms monitor CLI restart', () => {
  it('exits 7 when a second live monitor starts with the default stable token', async () => {
    const attachment = registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: '1710000001.000000',
      sessionId: 'sess-cli-duplicate',
      cwd: '/tmp',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
    });

    const first = spawnMonitor(attachment.id);
    await waitFor(() => {
      const current = registry.getAttachment(attachment.id);
      return current?.monitor_owner !== null;
    });

    const second = spawnMonitor(attachment.id);
    const code = await second.exited;
    const stderr = await new Response(
      second.stderr as ReadableStream<Uint8Array>,
    ).text();

    try {
      expect(code).toBe(7);
      expect(stderr).toContain('already owned');
    } finally {
      first.kill('SIGKILL');
      await first.exited;
    }
  }, 10_000);

  it('restarts inside the stale window without exiting 7', async () => {
    const attachment = registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: '1710000001.000001',
      sessionId: 'sess-cli-restart',
      cwd: '/tmp',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
    });

    const first = spawnMonitor(attachment.id);
    const firstClaimed = await Promise.race([
      waitFor(() => {
        const current = registry.getAttachment(attachment.id);
        return current?.monitor_owner !== null;
      }).then(() => ({ claimed: true as const })),
      first.exited.then((code) => ({ claimed: false as const, code })),
    ]);
    if (!firstClaimed.claimed) {
      const stderr = await new Response(
        first.stderr as ReadableStream<Uint8Array>,
      ).text();
      throw new Error(
        `first monitor exited before claiming ownership (code ${firstClaimed.code}): ${stderr}`,
      );
    }

    first.kill('SIGKILL');
    await first.exited;

    const second = spawnMonitor(attachment.id);
    const earlyExit = await Promise.race([
      second.exited.then((code) => ({ exited: true as const, code })),
      sleep(1_000).then(() => ({ exited: false as const })),
    ]);

    try {
      expect(earlyExit.exited).toBe(false);
    } finally {
      second.kill('SIGKILL');
      await second.exited;
    }
  }, 10_000);
});

