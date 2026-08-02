/**
 * Integration tests for Phase 2 HTTP monitor surface.
 *
 * Uses a real in-process Hono app backed by a real SQLite DurableRegistry
 * (in a temp dir) and fake Slack. No live daemon or network sockets needed.
 *
 * Test cases:
 *   1. Happy path: /attach-live → /monitor/wait → /monitor/emitted → /reply → /handled
 *   2. Duplicate-monitor 409 while owner healthy
 *   3. Stale-monitor takeover: simulate kill-9 mid-lease, new monitor reclaims
 *   4. Long-poll connection drop without check-in triggers stale transition within 60s
 *   5. Daemon restart mid-flight: reconcile returns leased → persisted; monitor reconnects
 *   6. Duplicate Slack event constraint violation: one row, one reaction path
 *   7. Duplicate POST /reply retry results in exactly one Slack post
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp, type ServerDeps } from '../src/http/server';
import type { DurableRegistry } from '../src/registry';
import {
  createDurableRegistry,
  LEASE_TTL_MS,
  STALE_THRESHOLD_MS,
} from '../src/registry';
import { ensureSecret } from '../src/secret';
import { makeServerDeps } from './fakes/deps';
import { createFakeSlackClient } from './fakes/slack';

// ---- Test constants ----

const CHANNEL = 'C_MONITOR';
const MACHINE = 'test-machine';

// Isolated HOME so each test run generates its own secret instead of touching
// the real ~/.claude/agent-comms/secret on the Mac Mini.
let tmpHome: string;
let originalHome: string | undefined;
let SECRET: string;

// ---- Helpers ----

function makeDeps(
  registry: DurableRegistry,
  fake: ReturnType<typeof createFakeSlackClient>,
  overrides: Partial<ServerDeps> = {},
): ServerDeps {
  return makeServerDeps(registry, fake, {
    channelId: CHANNEL,
    machineId: MACHINE,
    ...overrides,
  });
}

async function hitRoute(
  app: ReturnType<typeof createHttpApp>,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Agent-Comms-Secret': SECRET,
    ...extraHeaders,
  };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body:
        body !== undefined && method !== 'GET'
          ? JSON.stringify(body)
          : undefined,
    }),
  );
}

async function getMonitorWait(
  app: ReturnType<typeof createHttpApp>,
  attachmentId: string,
  ownerToken: string,
  pid = 12345,
  startedAt = 1000,
  signal?: AbortSignal,
): Promise<Response> {
  const qs = new URLSearchParams({
    attachment: attachmentId,
    owner_token: ownerToken,
    pid: String(pid),
    started_at: String(startedAt),
  });
  return app.fetch(
    new Request(`http://localhost/monitor/wait?${qs}`, {
      method: 'GET',
      headers: { 'X-Agent-Comms-Secret': SECRET },
      signal,
    }),
  );
}

// ---- Setup ----

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'http-monitor-home-'));
  process.env.HOME = tmpHome;
  SECRET = ensureSecret();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Phase 2: Monitor And Agent CLI Surface', () => {
  let tmpDir: string;
  let registry: DurableRegistry;
  let fake: ReturnType<typeof createFakeSlackClient>;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'http-monitor-test-'));
    registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
    fake = createFakeSlackClient();
    app = createHttpApp(makeDeps(registry, fake));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Happy path ────────────────────────────────────────────────────

  it('happy path: attach-live → wait → emitted → reply → handled', async () => {
    // 1a. POST /attach-live — creates attachment and Slack opener
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-happy',
    });
    expect(attachRes.status).toBe(200);
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    expect(attachBody.ok).toBe(true);
    const attachmentId = attachBody.attachment_id as string;
    expect(typeof attachmentId).toBe('string');
    expect(attachBody.created).toBe(true);
    expect(fake.posted).toHaveLength(1); // opener posted

    // 1b. Insert a fake inbound message (simulates Slack routing from Phase 3)
    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '111.222',
      senderId: 'U_SEAN',
      text: 'How is it going?',
      requiresResponse: true,
    });
    expect(msg.status).toBe('persisted');

    // 1c. GET /monitor/wait — claims ownership and leases the message
    const ownerToken = 'tok-happy-1';
    const waitRes = await getMonitorWait(app, attachmentId, ownerToken);
    expect(waitRes.status).toBe(200);
    const waitBody = (await waitRes.json()) as Record<string, unknown>;
    expect(waitBody.ok).toBe(true);
    const messages = waitBody.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
    expect(messages[0].status).toBe('leased');

    // 1d. POST /monitor/emitted — transition leased → emitted
    const emittedRes = await hitRoute(app, 'POST', '/monitor/emitted', {
      owner_token: ownerToken,
      message_ids: [msg.id],
    });
    expect(emittedRes.status).toBe(200);
    const emittedBody = (await emittedRes.json()) as Record<string, unknown>;
    expect(emittedBody.ok).toBe(true);
    expect(emittedBody.transitioned).toBe(1);

    // 1e. POST /reply — posts to Slack and marks handled
    const replyRes = await hitRoute(app, 'POST', '/reply', {
      attachment_id: attachmentId,
      message_id: msg.id,
      text: 'Still running tests!',
    });
    expect(replyRes.status).toBe(200);
    const replyBody = (await replyRes.json()) as Record<string, unknown>;
    expect(replyBody.ok).toBe(true);
    expect(replyBody.already_handled).toBeUndefined();

    // Verify Slack got the thread reply in the correct thread
    fake.assertPosted({ text: 'Still running tests!' });

    // 1f. Verify message is now handled in DB
    // (we don't expose getMessageById, so trust the idempotency test below to validate)
    expect(fake.posted).toHaveLength(2); // opener + reply
  });

  // ── Test 2: Duplicate-monitor 409 ────────────────────────────────────────

  it('duplicate-monitor 409 while owner healthy', async () => {
    // Create attachment
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-409',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    // First monitor claims ownership (long-poll returns immediately with empty)
    const tok1 = 'tok-409-first';
    const wait1 = await getMonitorWait(app, attachmentId, tok1, 100, 1000);
    expect(wait1.status).toBe(200);

    // Now update the expires_at to be in the future (it was set during claim)
    // The check-in refreshes TTL; for this test, the first claim set expires_at = now + 60s
    // so within the same test (< 60s), it should still be healthy.

    // Second monitor tries to connect — should get 409
    const tok2 = 'tok-409-second';
    const wait2 = await getMonitorWait(app, attachmentId, tok2, 200, 2000);
    expect(wait2.status).toBe(409);
    const wait2Body = (await wait2.json()) as Record<string, unknown>;
    expect(wait2Body.ok).toBe(false);
    expect(String(wait2Body.error)).toContain('already owned');
    const existing = wait2Body.existing as Record<string, unknown>;
    expect(existing.pid).toBe(100);
  });

  // ── Test 3: Stale-monitor takeover ───────────────────────────────────────

  it('stale-monitor takeover: new monitor reclaims in-flight leased message', async () => {
    const now = Date.now();

    // Create attachment
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-takeover',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    // Insert inbound message
    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '222.333',
      senderId: 'U_SEAN',
      text: 'Hello from Slack',
      requiresResponse: true,
    });

    // Simulate first monitor: claim ownership and lease the message directly
    // via registry (bypassing HTTP to avoid the long-poll wait).
    const tok1 = 'tok-stale-first';
    const claim = registry.claimMonitorOwnership({
      attachmentId,
      ownerToken: tok1,
      pid: 9999,
      startedAt: now - 120_000, // 2 minutes ago
      ttlMs: STALE_THRESHOLD_MS,
      now: now - 120_000,
    });
    expect(claim.ok).toBe(true);

    // Lease the message as first monitor
    const leased = registry.leaseNextMessages({
      attachmentId,
      ownerToken: tok1,
      leaseTtlMs: LEASE_TTL_MS,
      now: now - 120_000,
    });
    expect(leased).toHaveLength(1);
    expect(leased[0].status).toBe('leased');

    // Simulate kill-9: first monitor is now dead, TTL has long expired.
    // New monitor connects — should trigger takeover.
    const tok2 = 'tok-stale-second';
    // The claim will return stale_existing because expires_at is in the past.
    // The HTTP handler will route through takeOverStaleMonitor automatically.
    const takeoverRes = await getMonitorWait(
      app,
      attachmentId,
      tok2,
      8888,
      now,
    );
    expect(takeoverRes.status).toBe(200);
    const takeoverBody = (await takeoverRes.json()) as Record<string, unknown>;
    expect(takeoverBody.ok).toBe(true);
    // Takeover reclaimed the leased message back to persisted, then
    // immediately leased it to the new monitor.
    const messages = takeoverBody.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
  });

  // ── Test 4: Long-poll drop → stale within 60s ────────────────────────────

  it('long-poll connection drop without check-in: sweepStaleAttachments marks stale', async () => {
    const now = Date.now();

    // Create attachment and claim monitor ownership with an already-expired TTL
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-stale-sweep',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    // Claim monitor ownership with expires_at in the past (simulates a monitor
    // that connected 90s ago and never checked in again).
    const tok = 'tok-stale-drop';
    registry.claimMonitorOwnership({
      attachmentId,
      ownerToken: tok,
      pid: 5555,
      startedAt: now - 90_000,
      ttlMs: STALE_THRESHOLD_MS,
      now: now - 90_000, // claimed 90s ago → expired
    });

    // Sweep should mark this attachment stale
    const stalledIds = registry.sweepStaleAttachments(now);
    expect(stalledIds).toContain(attachmentId);

    // Verify attachment is now stale
    const attachment = registry.getAttachment(attachmentId);
    expect(attachment?.status).toBe('stale');
  });

  // ── Test 5: Daemon restart mid-flight ────────────────────────────────────

  it('daemon restart: reconcile returns leased → persisted; monitor reconnects and receives message', () => {
    const now = Date.now();

    // Create attachment + message + claim ownership + lease message directly
    const attachment = registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: '555.666',
      cwd: '/test',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
      now,
    });

    const msg = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '555.777',
      senderId: 'U_SEAN',
      text: 'Mid-flight message',
      requiresResponse: true,
      now,
    });

    // Claim and lease
    registry.claimMonitorOwnership({
      attachmentId: attachment.id,
      ownerToken: 'tok-restart',
      pid: 1111,
      startedAt: now - 30_000,
      ttlMs: STALE_THRESHOLD_MS,
      now: now - 30_000,
    });

    registry.leaseNextMessages({
      attachmentId: attachment.id,
      ownerToken: 'tok-restart',
      leaseTtlMs: LEASE_TTL_MS,
      now: now - 30_000, // leased 30s ago, TTL = 30s → just expired
    });

    // Simulate daemon restart: reconcileOnStartup should reclaim the leased message
    const result = registry.reconcileOnStartup(now);
    expect(result.reclaimedMessageIds).toContain(msg.id);

    // Verify message is back to persisted
    // (We verify via leaseNextMessages — if persisted, it will be leaseable again)
    const newOwner = 'tok-reconnect';
    registry.claimMonitorOwnership({
      attachmentId: attachment.id,
      ownerToken: newOwner,
      pid: 2222,
      startedAt: now,
      ttlMs: STALE_THRESHOLD_MS,
      now,
    });

    const msgs = registry.leaseNextMessages({
      attachmentId: attachment.id,
      ownerToken: newOwner,
      leaseTtlMs: LEASE_TTL_MS,
      now,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(msg.id);
  });

  // ── Test 6: Duplicate Slack event dedup ──────────────────────────────────

  it('duplicate Slack event constraint violation: one row in DB', () => {
    const attachment = registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: '777.888',
      cwd: '/test',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
    });

    const slackTs = '777.999';

    registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs,
      senderId: 'U_SEAN',
      text: 'First delivery',
      requiresResponse: true,
    });

    // Duplicate Slack event for the same slack_ts must throw (UNIQUE constraint)
    expect(() =>
      registry.insertInboundMessage({
        attachmentId: attachment.id,
        direction: 'slack_to_agent',
        slackTs,
        senderId: 'U_SEAN',
        text: 'Duplicate delivery',
        requiresResponse: true,
      }),
    ).toThrow();
  });

  // ── Test 7: Duplicate POST /reply → one Slack post ───────────────────────

  it('duplicate POST /reply HTTP retry results in exactly one Slack post', async () => {
    // Create attachment
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-idem',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    // Insert inbound message
    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '300.400',
      senderId: 'U_SEAN',
      text: 'Idempotent question',
      requiresResponse: true,
    });

    // First reply — should succeed and post to Slack
    const reply1 = await hitRoute(app, 'POST', '/reply', {
      attachment_id: attachmentId,
      message_id: msg.id,
      text: 'My idempotent reply',
    });
    expect(reply1.status).toBe(200);
    const reply1Body = (await reply1.json()) as Record<string, unknown>;
    expect(reply1Body.ok).toBe(true);
    expect(reply1Body.already_handled).toBeUndefined();

    const slackPostCountAfterFirst = fake.posted.length;

    // Duplicate retry — same (attachment_id, message_id) pair
    const reply2 = await hitRoute(app, 'POST', '/reply', {
      attachment_id: attachmentId,
      message_id: msg.id,
      text: 'My idempotent reply (retry)',
    });
    expect(reply2.status).toBe(200);
    const reply2Body = (await reply2.json()) as Record<string, unknown>;
    expect(reply2Body.ok).toBe(true);
    expect(reply2Body.already_handled).toBe(true);

    // Exactly zero additional Slack posts from the retry
    expect(fake.posted).toHaveLength(slackPostCountAfterFirst);
  });

  // ── Test 8: POST /handled idempotency ────────────────────────────────────

  it('POST /handled is idempotent on (attachment_id, message_id)', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-handled-idem',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '500.600',
      senderId: 'U_SEAN',
      text: 'No reply needed',
      requiresResponse: true,
    });

    const h1 = await hitRoute(app, 'POST', '/handled', {
      attachment_id: attachmentId,
      message_id: msg.id,
    });
    expect(h1.status).toBe(200);
    expect(
      ((await h1.json()) as Record<string, unknown>).already_handled,
    ).toBeUndefined();

    const h2 = await hitRoute(app, 'POST', '/handled', {
      attachment_id: attachmentId,
      message_id: msg.id,
    });
    expect(h2.status).toBe(200);
    expect(((await h2.json()) as Record<string, unknown>).already_handled).toBe(
      true,
    );
  });

  // ── Test 9: POST /monitor/checkin refreshes TTL ───────────────────────────

  it('POST /monitor/checkin refreshes owner TTL', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-checkin',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    // Claim ownership via wait
    const ownerToken = 'tok-checkin';
    const wait = await getMonitorWait(app, attachmentId, ownerToken);
    expect(wait.status).toBe(200);

    // Check-in as the same owner
    const checkinRes = await hitRoute(
      app,
      'POST',
      `/monitor/checkin?attachment=${attachmentId}`,
      { owner_token: ownerToken, pid: 12345, started_at: 1000 },
    );
    expect(checkinRes.status).toBe(200);
    expect(((await checkinRes.json()) as Record<string, unknown>).ok).toBe(
      true,
    );

    // Check-in from wrong owner should be rejected
    const badCheckin = await hitRoute(
      app,
      'POST',
      `/monitor/checkin?attachment=${attachmentId}`,
      { owner_token: 'wrong-token', pid: 9999, started_at: 1000 },
    );
    expect(badCheckin.status).toBe(409);
  });

  // ── Test 10: POST /status records agent activity ─────────────────────────

  it('POST /status posts to Slack and records agent activity', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-status',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    const before = registry.getAttachment(attachmentId);
    expect(before?.last_agent_activity_at).toBeNull();

    const statusRes = await hitRoute(app, 'POST', '/status', {
      attachment_id: attachmentId,
      text: 'Running phase 2 tests now',
    });
    expect(statusRes.status).toBe(200);
    fake.assertPosted({ text: 'Running phase 2 tests now' });

    const after = registry.getAttachment(attachmentId);
    expect(after?.last_agent_activity_at).not.toBeNull();
  });

  // ── Test 11: Unauthenticated requests are rejected ───────────────────────

  it('unauthenticated requests return 401', async () => {
    const res = await app.fetch(
      new Request('http://localhost/attach-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/test' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // ── Test 12: Missing attachment returns 404 ───────────────────────────────

  it('GET /monitor/wait returns 404 for unknown attachment', async () => {
    const res = await getMonitorWait(app, 'nonexistent-id', 'tok-404');
    expect(res.status).toBe(404);
  });

  // ── Test 13: /monitor/emitted rejects wrong owner ───────────────────────

  it('POST /monitor/emitted with mismatched owner does not transition message', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-bad-emitted',
    });
    const attachBody = (await attachRes.json()) as Record<string, unknown>;
    const attachmentId = attachBody.attachment_id as string;

    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '999.111',
      senderId: 'U_SEAN',
      text: 'Test message',
      requiresResponse: true,
    });

    // Lease via correct owner
    const correctOwner = 'tok-correct';
    await getMonitorWait(app, attachmentId, correctOwner);

    // Try to ack with wrong owner
    const res = await hitRoute(app, 'POST', '/monitor/emitted', {
      owner_token: 'tok-wrong',
      message_ids: [msg.id],
    });
    expect(res.status).toBe(200); // returns ok but transitioned=0
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.transitioned).toBe(0);
  });

  // ── Test 14: Same-monitor reconnect on /monitor/wait ──────────────────────

  it('GET /monitor/wait allows same owner_token to reconnect (refresh, not 409)', async () => {
    // Phase 1's claimMonitorOwnership is strict (only succeeds when
    // monitor_owner IS NULL). The /monitor/wait handler must distinguish
    // "different owner already holds the slot" (real 409) from "same monitor
    // reconnecting after long-poll timeout" (refresh + proceed). Otherwise
    // the CLI's normal long-poll loop dies after the first request.
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-reconnect',
    });
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;

    const ownerToken = 'tok-reconnect-1';

    // First wait — claims ownership, no message, returns empty after timeout
    const first = await getMonitorWait(app, attachmentId, ownerToken);
    expect(first.status).toBe(200);
    expect(
      ((await first.json()) as { messages: unknown[] }).messages,
    ).toHaveLength(0);

    // Insert a message after the first wait returned
    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      text: 'after-reconnect',
      requiresResponse: true,
    });

    // Second wait from SAME owner — must NOT 409. Must lease the message.
    const second = await getMonitorWait(app, attachmentId, ownerToken);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { messages: { id: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe(msg.id);
  });

  it('GET /monitor/wait rejects same owner_token from a second live process', async () => {
    const livePidApp = createHttpApp(
      makeDeps(registry, fake, { isPidAlive: () => true }),
    );
    const attachRes = await hitRoute(livePidApp, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-duplicate-same-token',
    });
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;
    const ownerToken = 'tok-same-live';

    const first = await getMonitorWait(
      livePidApp,
      attachmentId,
      ownerToken,
      100,
      1000,
    );
    expect(first.status).toBe(200);

    const second = await getMonitorWait(
      livePidApp,
      attachmentId,
      ownerToken,
      200,
      2000,
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe(
      'monitor already owned',
    );
  });

  it('GET /monitor/wait allows same owner_token from a dead prior process and reclaims its leases', async () => {
    const deadPidApp = createHttpApp(
      makeDeps(registry, fake, { isPidAlive: () => false }),
    );
    const attachRes = await hitRoute(deadPidApp, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-dead-same-token',
    });
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;
    const ownerToken = 'tok-same-dead';

    const claimed = registry.claimMonitorOwnership({
      attachmentId,
      ownerToken,
      pid: 100,
      startedAt: 1000,
    });
    expect(claimed.ok).toBe(true);

    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      text: 'leased by dead same-token owner',
      requiresResponse: true,
    });
    const leased = registry.leaseNextMessages({
      attachmentId,
      ownerToken,
    });
    expect(leased).toHaveLength(1);
    expect(registry.getMessageById(msg.id)?.status).toBe('leased');

    const restarted = await getMonitorWait(
      deadPidApp,
      attachmentId,
      ownerToken,
      200,
      2000,
    );
    expect(restarted.status).toBe(200);
    const body = (await restarted.json()) as { messages: { id: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe(msg.id);
    expect(registry.getAttachment(attachmentId)?.monitor_owner_pid).toBe(200);
  });

  // ── Test 15: /reply rejects cross-attachment message_id ────────────────────

  it('POST /reply rejects when message_id does not belong to attachment_id (no Slack post)', async () => {
    // Two attachments, one message belonging to att1.
    const a1 = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test/a1',
      session_id: 'sess-a1',
    });
    const a2 = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test/a2',
      session_id: 'sess-a2',
    });
    const att1Id = ((await a1.json()) as { attachment_id: string })
      .attachment_id;
    const att2Id = ((await a2.json()) as { attachment_id: string })
      .attachment_id;

    const msg = registry.insertInboundMessage({
      attachmentId: att1Id,
      direction: 'slack_to_agent',
      text: 'belongs to a1',
      requiresResponse: true,
    });

    const postedBefore = fake.posted.length;

    // Reply request says att2 + msg-from-att1. Must 404, must NOT Slack-post.
    const res = await hitRoute(app, 'POST', '/reply', {
      attachment_id: att2Id,
      message_id: msg.id,
      text: 'should not be posted',
    });
    expect(res.status).toBe(404);
    expect(fake.posted.length).toBe(postedBefore);

    // Message status must still be persisted (untouched)
    const after = registry.getMessageById(msg.id);
    expect(after?.status).toBe('persisted');
  });

  // ── Final-review fix: /reply post-fail leaves message retryable ──────────
  // High final-review finding: /reply marked handled BEFORE Slack post, so a
  // failed post permanently swallowed the reply (retry returned already_handled
  // and never reposted). Post-first / mark-on-success preserves retryability.

  it('POST /reply: failed Slack post does NOT mark handled (retry posts on next call)', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-retryable',
    });
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;
    const msg = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '777.888',
      senderId: 'U_SEAN',
      text: 'pls reply',
      requiresResponse: true,
    });

    // Wrap the existing fake's postThreadMessage so the FIRST call throws.
    const realPost = fake.postThreadMessage.bind(fake);
    let callCount = 0;
    fake.postThreadMessage = async (params: Parameters<typeof realPost>[0]) => {
      callCount++;
      if (callCount === 1) throw new Error('slack 503 transient');
      return realPost(params);
    };

    // Build a fresh app with the patched fake so it sees this version
    const patchedApp = createHttpApp(makeDeps(registry, fake));

    // First call: Slack throws → 502, message stays NOT handled.
    const r1 = await hitRoute(patchedApp, 'POST', '/reply', {
      attachment_id: attachmentId,
      message_id: msg.id,
      text: 'response',
    });
    expect(r1.status).toBe(502);

    // Verify message status is still routable (not handled)
    const after1 = registry.getMessageById(msg.id);
    expect(after1?.status).not.toBe('handled');

    // Second call: Slack succeeds → 200 with slack_ts, message now handled.
    const r2 = await hitRoute(patchedApp, 'POST', '/reply', {
      attachment_id: attachmentId,
      message_id: msg.id,
      text: 'response',
    });
    expect(r2.status).toBe(200);
    const r2Body = (await r2.json()) as Record<string, unknown>;
    expect(r2Body.ok).toBe(true);
    expect(r2Body.already_handled).toBeUndefined();
    expect(typeof r2Body.slack_ts).toBe('string');

    const after2 = registry.getMessageById(msg.id);
    expect(after2?.status).toBe('handled');

    expect(callCount).toBe(2); // exactly two Slack post attempts (one fail, one success)
  });

  // ── Final-review fix: attach-live discovers session_id from cwd ──────────
  // High final-review finding: the slash command does not pass session_id, so
  // attach-live stored session_id=null. /ask's session-id-based guard then
  // silently no-op'd, allowing ask to lazy-create a parallel legacy thread
  // from an attached session. attach-live now does server-side discovery via
  // discoverSession so attachments.session_id is reliably populated.

  it('POST /attach-live discovers session_id from cwd when body omits it', async () => {
    // Build a fresh app whose deps inject a discoverSession that returns a sessionId.
    const discoverDeps = {
      ...makeDeps(registry, fake),
      discoverSession: () => ({
        sessionId: 'sess-discovered-from-cwd',
        jsonlPath: '/fake/path/sess-discovered-from-cwd.jsonl',
        mtime: Date.now(),
      }),
    };
    const discoverApp = createHttpApp(discoverDeps);

    const attachRes = await hitRoute(discoverApp, 'POST', '/attach-live', {
      cwd: '/some/discovered/cwd',
      // session_id intentionally omitted
    });
    expect(attachRes.status).toBe(200);
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;

    const att = registry.getAttachment(attachmentId);
    expect(att?.session_id).toBe('sess-discovered-from-cwd');
  });

  // ── Test 16: Stale recovery transitions attachment back to active ─────────

  it('takeOverStaleMonitor recovers a stale attachment to active', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-stale-recover',
    });
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;

    // Owner1 claims, then we artificially mark stale
    registry.claimMonitorOwnership({
      attachmentId,
      ownerToken: 'owner-stale-1',
      pid: 1,
      startedAt: Date.now(),
    });
    registry.markAttachmentStale(attachmentId);
    expect(registry.getAttachment(attachmentId)?.status).toBe('stale');

    // Bump time past stale threshold so takeover is permitted
    const now = Date.now() + 60_001;
    const takeover = registry.takeOverStaleMonitor({
      attachmentId,
      newOwnerToken: 'owner-stale-2',
      newPid: 2,
      newStartedAt: now,
      now,
    });
    expect(takeover.ok).toBe(true);

    // Status must be active again — design requires recovery
    expect(registry.getAttachment(attachmentId)?.status).toBe('active');
  });

  // ── Test 17: Stale → checkin recovers to active ───────────────────────────

  it('monitorCheckin recovers a stale attachment to active', async () => {
    const attachRes = await hitRoute(app, 'POST', '/attach-live', {
      cwd: '/test',
      session_id: 'sess-stale-checkin',
    });
    const attachmentId = ((await attachRes.json()) as { attachment_id: string })
      .attachment_id;

    registry.claimMonitorOwnership({
      attachmentId,
      ownerToken: 'owner-checkin',
      pid: 1,
      startedAt: Date.now(),
    });
    registry.markAttachmentStale(attachmentId);

    // Owner check-in must restore status to active
    const ok = registry.monitorCheckin({
      attachmentId,
      ownerToken: 'owner-checkin',
    });
    expect(ok).toBe(true);
    expect(registry.getAttachment(attachmentId)?.status).toBe('active');
  });
});

