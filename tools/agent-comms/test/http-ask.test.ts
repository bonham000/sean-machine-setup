import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAskRegistry } from '../src/asks';
import type { AskDeps } from '../src/http/routes/ask';
import { askRoute } from '../src/http/routes/ask';
import type { DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import type { SlackPoster } from '../src/slack/types';
import { makeThreadUrl, postJson as postAsk } from './fakes/deps';
import { createFakeSlackClient } from './fakes/slack';

const CHANNEL = 'C_ASK';
const MACHINE = 'test-machine';

describe('askRoute', () => {
  let tmpDir: string;
  let registry: DurableRegistry;
  let fake: ReturnType<typeof createFakeSlackClient>;
  let askReg: ReturnType<typeof createAskRegistry>;
  let deps: AskDeps;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'http-ask-test-'));
    registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
    fake = createFakeSlackClient();
    askReg = createAskRegistry();

    deps = {
      channelId: CHANNEL,
      machineId: MACHINE,
      registry,
      poster: fake,
      threadUrl: makeThreadUrl,
      discoverSession: () => null, // tests always supply session_id explicitly
      askRegistry: askReg,
    };
  });

  afterEach(() => {
    askReg.shutdownAll('test_cleanup');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('held request resolves when ask is resolved with reply text', async () => {
    const responsePromise = postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-ask-1',
      text: 'Should I proceed?',
    });

    // Give the route a moment to register the ask
    await new Promise((r) => setTimeout(r, 20));

    // Simulate the user replying — find the thread_ts from the registry
    const row = registry.findActiveBySessionId('sess-ask-1');
    expect(row).not.toBeNull();

    const resolved = askReg.resolve(row!.thread_ts, 'yes go ahead');
    expect(resolved).toBe(true);

    const res = await responsePromise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.reply).toBe('yes go ahead');
    expect(typeof body.thread_url).toBe('string');
  });

  it('timeout_seconds = 0.01 returns 408 timed_out', async () => {
    const res = await postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-ask-timeout',
      text: 'Are you there?',
      timeout_seconds: 0.01,
    });
    expect(res.status).toBe(408);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('timed_out');
    expect(typeof body.thread_url).toBe('string');
  });

  it('duplicate pending ask returns 409 without posting a second question', async () => {
    // First ask — keep it pending
    const first = postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-ask-dup',
      text: 'question 1',
    });

    await new Promise((r) => setTimeout(r, 20));

    // Second ask on same session (same thread_ts) → 409
    const secondRes = await postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-ask-dup',
      text: 'question 2',
    });
    expect(secondRes.status).toBe(409);
    const body = (await secondRes.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('already_pending');

    // Only one question was ever posted (the opener + the first question)
    // The second question must NOT have been posted
    const textMessages = fake.posted.filter((m) => m.text === 'question 2');
    expect(textMessages).toHaveLength(0);

    // Clean up first
    const row = registry.findActiveBySessionId('sess-ask-dup');
    if (row) askReg.resolve(row.thread_ts, 'done');
    await first;
  });

  it('daemon shutdown returns 503', async () => {
    const responsePromise = postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-ask-shutdown',
      text: 'waiting...',
    });

    await new Promise((r) => setTimeout(r, 20));
    askReg.shutdownAll('daemon_shutdown');

    const res = await responsePromise;
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('daemon_shutdown');
  });

  it('returns 400 when cwd is missing', async () => {
    const res = await postAsk(askRoute(deps), {
      session_id: 'sess-ask-400',
      text: 'hi',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when text is missing', async () => {
    const res = await postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-ask-400b',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when session is not discoverable', async () => {
    const res = await postAsk(askRoute(deps), {
      cwd: '/no-session',
      text: 'hello?',
    });
    expect(res.status).toBe(404);
  });

  it('returns 502 when Slack post fails and does not leak the reservation', async () => {
    const failPoster: SlackPoster = {
      async postOpener() {
        throw new Error('Slack down');
      },
      async postThreadMessage() {
        throw new Error('Slack down');
      },
    };

    const res = await postAsk(askRoute({ ...deps, poster: failPoster }), {
      cwd: '/test',
      session_id: 'sess-ask-fail-post',
      text: 'hello?',
    });
    expect(res.status).toBe(502);

    // No pending ask leaked
    // (The opener attempt would create a registry row then fail on postThreadMessage,
    //  OR the opener itself fails before any registration. Either way, if a reservation
    //  exists it must have been cancelled by the route.)
    const row = registry.findActiveBySessionId('sess-ask-fail-post');
    // If no row exists (opener failed), there's nothing to check.
    // If row exists, the ask must no longer be pending.
    if (row) {
      expect(askReg.hasPending(row.thread_ts)).toBe(false);
    }
  });

  it('client abort cancels the reservation and returns an error', async () => {
    const controller = new AbortController();
    const responsePromise = postAsk(
      askRoute(deps),
      {
        cwd: '/test',
        session_id: 'sess-ask-abort',
        text: 'still there?',
      },
      controller.signal,
    );

    // Let the route reserve the ask
    await new Promise((r) => setTimeout(r, 20));

    const row = registry.findActiveBySessionId('sess-ask-abort');
    expect(row).not.toBeNull();
    expect(askReg.hasPending(row!.thread_ts)).toBe(true);

    controller.abort();

    // The HTTP layer raises on abort; the route's own response (if any) is
    // not received by the client. We only need to verify the reservation is
    // cancelled so it cannot leak across requests.
    await responsePromise.catch(() => {
      /* expected on abort */
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(askReg.hasPending(row!.thread_ts)).toBe(false);
  });

  it('Slack post failure does not leave an unhandled rejection on reserved.promise', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const failPoster: SlackPoster = {
        async postOpener() {
          // Opener succeeds so a registry row exists; only postThreadMessage fails.
          return { ts: '1700000000.000100' };
        },
        async postThreadMessage() {
          throw new Error('Slack down');
        },
      };

      const res = await postAsk(askRoute({ ...deps, poster: failPoster }), {
        cwd: '/test',
        session_id: 'sess-ask-no-leak',
        text: 'hi?',
      });
      expect(res.status).toBe(502);

      // Give microtasks a chance to flush a hypothetical unobserved rejection.
      await new Promise((r) => setTimeout(r, 30));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('lazy-creates thread on first ask', async () => {
    const responsePromise = postAsk(askRoute(deps), {
      cwd: '/test',
      session_id: 'sess-lazy-ask',
      text: 'Are you there?',
    });

    await new Promise((r) => setTimeout(r, 20));

    const row = registry.findActiveBySessionId('sess-lazy-ask');
    expect(row).not.toBeNull();

    askReg.resolve(row!.thread_ts, 'yes');
    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(fake.posted.some((m) => !m.threadTs)).toBe(true); // opener posted
  });

  // ── Phase 3 precedence: durable check runs BEFORE resolveOrCreateThread ──
  // Codex Phase 3 finding: previously /ask called resolveOrCreateThread first,
  // which lazy-created a fresh legacy handoff + posted a Slack opener BEFORE
  // the durable-attachment 409 fired. An attached session with no legacy
  // handoff row therefore got an unwanted thread before the rejection.
  // Fix: durable check now runs first; on hit we 409 and post NOTHING.
  it('rejects with 409 when session has an active durable attachment, posts NO Slack opener', async () => {
    // Set up a durable registry with an active attachment for this session.
    const { createDurableRegistry } = await import('../src/registry');
    const durable = createDurableRegistry({
      dbPath: join(tmpDir, 'durable.db'),
    });
    durable.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: '999.000',
      sessionId: 'sess-already-attached',
      cwd: '/test',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
    });

    // No pre-existing legacy handoff row for this session.
    expect(registry.findActiveBySessionId('sess-already-attached')).toBeNull();

    const askedDeps: AskDeps = { ...deps, durableRegistry: durable };
    const postedBefore = fake.posted.length;

    const res = await postAsk(askRoute(askedDeps), {
      cwd: '/test',
      session_id: 'sess-already-attached',
      text: 'should be rejected',
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('active durable attachment');

    // CRITICAL: no Slack opener was posted (the order-of-ops bug would post one).
    expect(fake.posted.length).toBe(postedBefore);

    // CRITICAL: no legacy handoff row was created.
    expect(registry.findActiveBySessionId('sess-already-attached')).toBeNull();
  });
});

