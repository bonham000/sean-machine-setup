import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostDeps } from '../src/http/routes/post';
import { postRoute } from '../src/http/routes/post';
import type { DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import type { SlackPoster } from '../src/slack/types';
import { makeThreadUrl, postJson as post } from './fakes/deps';
import { createFakeSlackClient } from './fakes/slack';

const CHANNEL = 'C_POST';
const MACHINE = 'test-machine';

describe('postRoute', () => {
  let tmpDir: string;
  let registry: DurableRegistry;
  let fake: ReturnType<typeof createFakeSlackClient>;
  let deps: PostDeps;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'http-post-test-'));
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

  it('first post lazy-creates thread, posts opener, then posts message into thread', async () => {
    const res = await post(postRoute(deps), {
      cwd: '/test',
      session_id: 'sess-post-1',
      text: 'hello world',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(typeof body.thread_url).toBe('string');

    // Opener posted (no threadTs), then thread message posted (with threadTs)
    expect(fake.posted).toHaveLength(2);
    const [opener, msg] = fake.posted;
    expect(opener!.threadTs).toBeUndefined();
    expect(msg!.threadTs).toBeDefined();
    expect(msg!.text).toBe('hello world');

    // Registry row created
    expect(registry.findActiveBySessionId('sess-post-1')).not.toBeNull();
  });

  it('second post reuses existing thread without creating a new one', async () => {
    // First post — creates thread
    await post(postRoute(deps), {
      cwd: '/test',
      session_id: 'sess-post-2',
      text: 'first',
    });
    fake.reset();

    // Second post — reuses
    const res = await post(postRoute(deps), {
      cwd: '/test',
      session_id: 'sess-post-2',
      text: 'second',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.created).toBe(false);

    // Only one message posted (no new opener)
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.text).toBe('second');
  });

  it('returns 400 when text is missing', async () => {
    const res = await post(postRoute(deps), {
      cwd: '/test',
      session_id: 'sess-3',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
  });

  it('returns 400 when text is whitespace-only', async () => {
    const res = await post(postRoute(deps), {
      cwd: '/test',
      session_id: 'sess-3',
      text: '   ',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when cwd is missing', async () => {
    const res = await post(postRoute(deps), {
      session_id: 'sess-4',
      text: 'hi',
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 when opener (lazy-create) fails; does not insert registry row', async () => {
    const failOpener: SlackPoster = {
      async postOpener() {
        throw new Error('Slack opener failed');
      },
      async postThreadMessage() {
        return { ts: '99' };
      },
    };

    const res = await post(postRoute({ ...deps, poster: failOpener }), {
      cwd: '/test',
      session_id: 'sess-fail-opener',
      text: 'hi',
    });
    expect(res.status).toBe(502);

    // No registry row inserted
    expect(registry.findActiveBySessionId('sess-fail-opener')).toBeNull();
  });

  it('returns 502 when postThreadMessage fails after lazy-create; keeps registry row', async () => {
    let openerCalled = false;
    const failThreadPost: SlackPoster = {
      async postOpener(_params) {
        openerCalled = true;
        return { ts: 'opened-ts' };
      },
      async postThreadMessage() {
        throw new Error('thread post failed');
      },
    };

    const res = await post(postRoute({ ...deps, poster: failThreadPost }), {
      cwd: '/test',
      session_id: 'sess-fail-thread',
      text: 'hi',
    });
    expect(res.status).toBe(502);
    expect(openerCalled).toBe(true);

    // Registry row WAS inserted (Slack thread now exists even though user msg failed)
    expect(registry.findActiveBySessionId('sess-fail-thread')).not.toBeNull();
  });

  it('returns 404 when no session is discoverable and no session_id given', async () => {
    const res = await post(postRoute(deps), { cwd: '/no-session', text: 'hi' });
    expect(res.status).toBe(404);
  });
});

