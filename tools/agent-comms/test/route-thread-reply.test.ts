/**
 * Regression tests for routeThreadReply — Phase 3 routing ladder + Phase 5
 * @-mention durable fork.
 *
 * Covers all four branches:
 *   1. Active durable attachment
 *      a. delivery_adapter='monitor' (terminal-attached): persist, react 📥, start heartbeat
 *      b. delivery_adapter='daemon-worker' (@-mention durable): persist, react 📥, kick worker, NO heartbeat
 *   2. Legacy handoffs row (no attachment) → post dead-thread notice
 *   3. Non-attached pending ask → resolve, react ✅
 *   4. No context → silently ignore
 *
 * Also covers:
 *   - Duplicate Slack event dedup (same slack_ts → constraint violation → ignore)
 *   - Bot @-mention in active thread → clarification post, no persist
 *
 * Harness processes never start synchronously in routeThreadReply. Tests use a
 * fake DaemonWorker and assert only that daemon-owned replies enqueue it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AskRegistry } from '../src/asks';
import { createAskRegistry } from '../src/asks';
import type { DurableRegistry, Registry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import type { RouteThreadReplyArgs } from '../src/slack/app';
import { routeThreadReply } from '../src/slack/app';
import type { DaemonWorker } from '../src/slack/daemon-worker';
import type {
  HeartbeatManager,
  HeartbeatStartParams,
} from '../src/slack/heartbeat';
import { createFakeSlackClient } from './fakes/slack';

interface KickRecord {
  attachmentId: string;
  messageId: string;
}

function makeFakeDaemonWorker(): {
  worker: DaemonWorker;
  kicked: KickRecord[];
} {
  const kicked: KickRecord[] = [];
  const worker: DaemonWorker = {
    kick(params) {
      kicked.push({ ...params });
    },
    async drain() {
      /* no-op */
    },
  };
  return { worker, kicked };
}

const CHANNEL = 'C_RTR';
const THREAD_TS = '100.000';

function makeFakeHeartbeatManager(): {
  hbManager: HeartbeatManager;
  started: HeartbeatStartParams[];
} {
  const started: HeartbeatStartParams[] = [];
  const hbManager: HeartbeatManager = {
    start(params) {
      started.push({ ...params });
    },
    stop(_messageId) {},
    stopAll() {},
  };
  return { hbManager, started };
}

describe('routeThreadReply — Phase 3 regression', () => {
  let tmpDir: string;
  let durableRegistry: DurableRegistry;
  let legacyRegistry: Registry;
  let askReg: AskRegistry;
  let fake: ReturnType<typeof createFakeSlackClient>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rtr-test-'));
    durableRegistry = createDurableRegistry({
      dbPath: join(tmpDir, 'registry.db'),
    });
    legacyRegistry = durableRegistry; // DurableRegistry satisfies Registry
    askReg = createAskRegistry();
    fake = createFakeSlackClient();
  });

  afterEach(() => {
    askReg.shutdownAll('test_cleanup');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeArgs(
    overrides: Partial<RouteThreadReplyArgs>,
  ): RouteThreadReplyArgs {
    return {
      threadTs: THREAD_TS,
      channel: CHANNEL,
      ts: 'msg-ts-1',
      text: 'hello',
      userId: 'U_TEST',
      selfBotUserId: undefined,
      poster: fake,
      registry: legacyRegistry,
      durableRegistry,
      askRegistry: askReg,
      reactor: fake,
      heartbeatManager: null,
      daemonWorker: null,
      ...overrides,
    };
  }

  // ── Branch 1: active durable attachment ──────────────────────────────────

  it('active attachment: persists message, reacts 📥, starts heartbeat', async () => {
    const now = Date.now();
    const attachment = durableRegistry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      cwd: '/test',
      machineId: 'test-machine',
      ownerMode: 'terminal-attached',
      now,
    });

    const { hbManager, started } = makeFakeHeartbeatManager();

    await routeThreadReply(
      makeArgs({
        ts: 'slack-ts-1',
        text: 'send this',
        heartbeatManager: hbManager,
      }),
    );

    // No Slack post — inbox delivery is through monitor, not a direct post
    expect(fake.posted).toHaveLength(0);
    // Reacted with 📥
    fake.assertReacted({ name: 'inbox_tray', timestamp: 'slack-ts-1' });
    // Heartbeat started for the new message
    expect(started).toHaveLength(1);
    expect(started[0]!.attachmentId).toBe(attachment.id);

    // Message persisted in durable registry
    const msg = durableRegistry.getMessageById(started[0]!.messageId);
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('send this');
    expect(msg!.slack_ts).toBe('slack-ts-1');
  });

  // ── Branch 1b: active durable attachment, delivery_adapter='daemon-worker' ─

  it('daemon-worker attachment: persists message, reacts 📥, kicks worker, does NOT start heartbeat', async () => {
    const now = Date.now();
    const attachment = durableRegistry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      cwd: '/test',
      machineId: 'test-machine',
      ownerMode: 'daemon-spawned',
      deliveryAdapter: 'daemon-worker',
      now,
    });

    const { hbManager, started } = makeFakeHeartbeatManager();
    const { worker, kicked } = makeFakeDaemonWorker();

    await routeThreadReply(
      makeArgs({
        ts: 'slack-ts-dw',
        text: 'follow-up after the mention',
        heartbeatManager: hbManager,
        daemonWorker: worker,
      }),
    );

    fake.assertReacted({ name: 'inbox_tray', timestamp: 'slack-ts-dw' });
    // Worker was kicked with the persisted message id
    expect(kicked).toHaveLength(1);
    expect(kicked[0]!.attachmentId).toBe(attachment.id);
    const persisted = durableRegistry.getMessageById(kicked[0]!.messageId);
    expect(persisted).not.toBeNull();
    expect(persisted!.text).toBe('follow-up after the mention');
    // Heartbeat is monitor-only; daemon-worker handles its own _thinking..._
    expect(started).toHaveLength(0);
  });

  // ── Duplicate Slack event dedup ──────────────────────────────────────────

  it('duplicate slack_ts: second event with same ts is silently ignored', async () => {
    const now = Date.now();
    durableRegistry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      cwd: '/test',
      machineId: 'test-machine',
      ownerMode: 'terminal-attached',
      now,
    });

    const { hbManager, started } = makeFakeHeartbeatManager();

    // First delivery
    await routeThreadReply(
      makeArgs({ ts: 'dup-ts', heartbeatManager: hbManager }),
    );
    // Second delivery of the same Slack event
    await routeThreadReply(
      makeArgs({ ts: 'dup-ts', heartbeatManager: hbManager }),
    );

    // Only one 📥 reaction and one heartbeat start — duplicate silently dropped
    expect(fake.reactions.filter((r) => r.name === 'inbox_tray')).toHaveLength(
      1,
    );
    expect(started).toHaveLength(1);
  });

  // ── Bot @-mention in active thread ──────────────────────────────────────

  it('bot @-mention in active thread: posts clarification, does not persist', async () => {
    const now = Date.now();
    durableRegistry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      cwd: '/test',
      machineId: 'test-machine',
      ownerMode: 'terminal-attached',
      now,
    });

    const { hbManager, started } = makeFakeHeartbeatManager();

    await routeThreadReply(
      makeArgs({
        ts: 'mention-ts',
        text: '<@UBOT123> are you there?',
        selfBotUserId: 'UBOT123',
        heartbeatManager: hbManager,
      }),
    );

    // Clarification message posted
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.text).toContain('@-mentioned');
    // No heartbeat — message was not persisted
    expect(started).toHaveLength(0);
    // No 📥 reaction
    expect(fake.reactions.filter((r) => r.name === 'inbox_tray')).toHaveLength(
      0,
    );
  });

  // ── Branch 2: legacy handoffs row, no active attachment ─────────────────

  it('legacy handoffs row: posts dead-thread notice, no heartbeat started', async () => {
    legacyRegistry.insertHandoff({
      thread_ts: THREAD_TS,
      channel_id: CHANNEL,
      session_id: 'sess-legacy',
      cwd: '/test',
      machine_id: 'test',
      opened_at: Date.now(),
    });

    const { hbManager, started } = makeFakeHeartbeatManager();

    await routeThreadReply(
      makeArgs({
        durableRegistry: null, // no active attachment lookup
        heartbeatManager: hbManager,
      }),
    );

    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.text).toContain('previous version of agent-comms');
    expect(started).toHaveLength(0);
  });

  it('errored legacy handoffs row: also posts dead-thread notice', async () => {
    legacyRegistry.insertHandoff({
      thread_ts: THREAD_TS,
      channel_id: CHANNEL,
      session_id: 'sess-errored',
      cwd: '/test',
      machine_id: 'test',
      opened_at: Date.now(),
    });
    legacyRegistry.markStatus(THREAD_TS, 'errored');

    await routeThreadReply(makeArgs({ durableRegistry: null }));

    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.text).toContain('previous version of agent-comms');
  });

  it('ended legacy handoffs row: silently ignored (not re-attach)', async () => {
    legacyRegistry.insertHandoff({
      thread_ts: THREAD_TS,
      channel_id: CHANNEL,
      session_id: 'sess-ended',
      cwd: '/test',
      machine_id: 'test',
      opened_at: Date.now(),
    });
    legacyRegistry.markStatus(THREAD_TS, 'ended');

    await routeThreadReply(makeArgs({ durableRegistry: null }));

    expect(fake.posted).toHaveLength(0);
  });

  // ── Branch 3: non-attached pending ask ──────────────────────────────────

  it('non-attached pending ask: resolves ask, reacts ✅, no heartbeat', async () => {
    const reserved = askReg.reserve(THREAD_TS, { timeoutMs: 5000 });
    expect(reserved.ok).toBe(true);

    const { hbManager, started } = makeFakeHeartbeatManager();

    await routeThreadReply(
      makeArgs({
        ts: 'ask-ts',
        text: 'my answer',
        durableRegistry: null,
        heartbeatManager: hbManager,
      }),
    );

    if (!reserved.ok) return;
    const reply = await reserved.promise;
    expect(reply).toBe('my answer');
    fake.assertReacted({ name: 'white_check_mark', timestamp: 'ask-ts' });
    expect(fake.posted).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it('legacy handoffs row wins over pending ask (precedence: dead-thread notice, ask left pending)', async () => {
    // Documents the precedence between branches 2 and 3: the legacy handoffs
    // lookup runs BEFORE the non-attached ask check, so a pending ask on a
    // thread that also has an active handoffs row gets the dead-thread notice
    // and is NOT resolved. In practice an ask on a handoffs thread is unusual.
    legacyRegistry.insertHandoff({
      thread_ts: THREAD_TS,
      channel_id: CHANNEL,
      session_id: 'sess-both',
      cwd: '/test',
      machine_id: 'test',
      opened_at: Date.now(),
    });
    const reserved = askReg.reserve(THREAD_TS, { timeoutMs: 1000 });
    expect(reserved.ok).toBe(true);

    await routeThreadReply(
      makeArgs({
        ts: 'msg-ts-both',
        text: 'answer',
        durableRegistry: null,
      }),
    );

    // Dead-thread notice was posted (legacy handoffs wins over pending ask)
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.text).toContain('previous version of agent-comms');

    // The ask was NOT resolved
    expect(askReg.hasPending(THREAD_TS)).toBe(true);
    // Swallow the expected rejection before canceling so Bun doesn't flag it
    // as an unhandled promise rejection.
    if (reserved.ok) reserved.promise.catch(() => {});
    askReg.cancel(THREAD_TS, 'test_cleanup');
  });

  // ── Branch 4: ignore ────────────────────────────────────────────────────

  it('unregistered thread with no ask: silently ignored', async () => {
    const { hbManager, started } = makeFakeHeartbeatManager();

    await routeThreadReply(
      makeArgs({ threadTs: 'no-context-ts', heartbeatManager: hbManager }),
    );

    expect(fake.posted).toHaveLength(0);
    expect(fake.reactions).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  // ── Stale durable attachment: still routes to inbox + heartbeat ─────────
  // High Codex finding from Phase 3 review: stale attachments must still
  // receive inbound messages so heartbeat can post the stale-status notice.
  // findRoutableAttachmentByChannelThread (vs findActive) covers this.
  it('stale durable attachment: persists, reacts, starts heartbeat (lets heartbeat surface stale notice)', async () => {
    const { hbManager, started } = makeFakeHeartbeatManager();
    const att = durableRegistry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: 'stale-attached-ts',
      cwd: '/test/stale',
      machineId: 'test-machine',
      ownerMode: 'terminal-attached',
    });
    durableRegistry.markAttachmentStale(att.id);
    expect(durableRegistry.getAttachment(att.id)?.status).toBe('stale');

    await routeThreadReply(
      makeArgs({
        threadTs: 'stale-attached-ts',
        text: 'sent while stale',
        heartbeatManager: hbManager,
      }),
    );

    fake.assertReacted({ name: 'inbox_tray' });
    expect(started).toHaveLength(1);
  });
});

