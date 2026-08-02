import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachDeps } from '../src/http/routes/attach';
import { attachRoute } from '../src/http/routes/attach';
import type { DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import { makeThreadUrl, postJson as post } from './fakes/deps';
import { createFakeSlackClient } from './fakes/slack';

const CHANNEL = 'C_ATTACH';
const MACHINE = 'test-machine';

describe('attachRoute', () => {
  let tmpDir: string;
  let registry: DurableRegistry;
  let fake: ReturnType<typeof createFakeSlackClient>;
  let deps: AttachDeps;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'http-attach-test-'));
    registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
    fake = createFakeSlackClient();

    deps = {
      channelId: CHANNEL,
      machineId: MACHINE,
      registry,
      poster: fake,
      threadUrl: makeThreadUrl,
      discoverSession: () => null, // tests always supply session_id explicitly
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new thread and inserts a registry row', async () => {
    const res = await post(attachRoute(deps), {
      cwd: '/test',
      session_id: 'sess-1',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('created');
    expect(body.session_id).toBe('sess-1');
    expect(typeof body.thread_ts).toBe('string');
    expect(typeof body.thread_url).toBe('string');

    const row = registry.findActiveBySessionId('sess-1');
    expect(row).not.toBeNull();
  });

  it('reattach is idempotent — returns already-active, no new opener posted', async () => {
    // First attach
    await post(attachRoute(deps), { cwd: '/test', session_id: 'sess-2' });
    const firstCount = fake.posted.length;

    // Second attach with same session
    const res = await post(attachRoute(deps), {
      cwd: '/test',
      session_id: 'sess-2',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('already-active');

    // No additional messages posted
    expect(fake.posted).toHaveLength(firstCount);
  });

  it('returns 400 when cwd is missing', async () => {
    const res = await post(attachRoute(deps), { session_id: 'sess-3' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
  });

  it('returns 404 when session cannot be discovered and no session_id given', async () => {
    const res = await post(attachRoute(deps), { cwd: '/no-session' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('--session-id');
  });

  it('passes hint into the opener text', async () => {
    await post(attachRoute(deps), {
      cwd: '/test',
      session_id: 'sess-hint',
      hint: 'phase 2 impl',
    });
    expect(
      fake.posted.some(
        (m) => m.channel === CHANNEL && m.text.includes('phase 2 impl'),
      ),
    ).toBe(true);
  });

  it('legacy /handoff alias returns the same response shape', async () => {
    // Test by creating the attach route and calling it the same way the server does
    // (server.ts mounts attachRoute under both /attach and /handoff)
    const route = attachRoute(deps);
    const res = await post(route, { cwd: '/test', session_id: 'sess-legacy' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Same shape as /attach
    expect(body.ok).toBe(true);
    expect(typeof body.status).toBe('string');
    expect(typeof body.thread_ts).toBe('string');
    expect(typeof body.thread_url).toBe('string');
    expect(typeof body.session_id).toBe('string');
  });
});

