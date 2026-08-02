/**
 * Heartbeat unit tests — Phase 3 + minimal-noise redesign.
 *
 * Covers:
 *   - reply termination (external stop)
 *   - handled termination (polled: message.status = 'handled')
 *   - stale termination (one-shot notice, then suspended)
 *   - ended termination (final post)
 *   - errored termination (final post)
 *   - 60-minute cap (timeout post)
 *   - stale-then-recovered: stale notice once, recovery is silent (📥 + later
 *     _still working..._ post if work is slow are user-visible signals)
 *   - heartbeat NEVER posts _thinking..._ on its own (the only _thinking..._
 *     in the system is the @-mention welcome posted by handler.ts before the
 *     daemon spawns a fresh CC session — out of scope for this manager)
 *   - all inbound messages: silent until postIntervalMs elapses, then
 *     _still working..._ kicks in (5 min default)
 *   - _queued_ phase stays quiet when monitor is not yet healthy
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AttachmentRow,
  DurableRegistry,
  MessageRow,
} from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import type { HeartbeatManager } from '../src/slack/heartbeat';
import { createHeartbeatManager } from '../src/slack/heartbeat';
import { waitFor } from './fakes/deps';
import { makePoster } from './fakes/slack';

// ---- Constants ----

const CHANNEL = 'C_HB';
const THREAD_TS = '111.222';
const CHECK_MS = 50; // accelerated check interval for tests
const POST_MS = 200; // accelerated post interval
const MAX_MS = 1000; // accelerated 60-min cap

// ---- Helpers ----

/** Create attachment and message with controllable state using public registry API only. */
function makeFixture(
  tmpDir: string,
  overrides?: {
    messageStatus?: 'handled' | 'emitted';
    attachmentStatus?: AttachmentRow['status'];
    monitorExpiresAt?: number;
    /** Set the cc_pid column at creation. */
    ccPid?: number;
  },
): {
  registry: DurableRegistry;
  attachment: AttachmentRow;
  message: MessageRow;
} {
  const registry = createDurableRegistry({
    dbPath: join(tmpDir, 'registry.db'),
  });
  const now = Date.now();

  const attachment = registry.createOrReuseAttachment({
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    cwd: '/test',
    machineId: 'test',
    ownerMode: 'terminal-attached',
    ccPid: overrides?.ccPid ?? null,
    now,
  });

  const message = registry.insertInboundMessage({
    attachmentId: attachment.id,
    direction: 'slack_to_agent',
    slackTs: '111.333',
    senderId: 'U_SEAN',
    text: 'hello',
    requiresResponse: true,
    now,
  });

  // Message status overrides
  if (overrides?.messageStatus === 'handled') {
    registry.markMessageHandled({
      attachmentId: attachment.id,
      messageId: message.id,
      now,
    });
  } else if (overrides?.messageStatus === 'emitted') {
    // Lease with a fake token then emit. The token is used only here — no
    // monitor claim needed, so monitor_owner_expires_at stays null (not healthy).
    const fakeToken = 'test-lease-tok';
    registry.leaseNextMessages({
      attachmentId: attachment.id,
      ownerToken: fakeToken,
      now,
    });
    registry.markMessageEmitted({
      messageId: message.id,
      ownerToken: fakeToken,
      now,
    });
  }

  // Attachment status overrides
  if (overrides?.attachmentStatus === 'stale') {
    registry.markAttachmentStale(attachment.id, now);
  } else if (overrides?.attachmentStatus === 'ended') {
    registry.markAttachmentEnded(attachment.id);
  } else if (overrides?.attachmentStatus === 'errored') {
    registry.markAttachmentErrored(attachment.id);
  }

  // Monitor health override — only when an explicit future expiry is requested.
  // We claim with the running test process's own PID so the PID-fast-stale
  // probe in heartbeat.ts treats the monitor as alive in tests that don't
  // explicitly inject isPidAlive. Tests that exercise the dead-PID path
  // override isPidAlive directly when constructing the heartbeat manager.
  if (overrides?.monitorExpiresAt !== undefined) {
    const ttlMs = Math.max(overrides.monitorExpiresAt - now, 1);
    registry.claimMonitorOwnership({
      attachmentId: attachment.id,
      ownerToken: 'test-monitor-tok',
      pid: process.pid,
      startedAt: now,
      ttlMs,
      now,
    });
  }

  return { registry, attachment, message };
}

// ---- Tests ----

describe('HeartbeatManager', () => {
  let tmpDir: string;
  let hb: HeartbeatManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-test-'));
  });

  afterEach(() => {
    hb?.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── reply termination (external stop) ────────────────────────────────────

  it('stop() immediately terminates the heartbeat — no posts after stop', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      // Monitor healthy → first user-visible post would be a _still working..._
      // after postIntervalMs. We stop before any tick fires.
      monitorExpiresAt: Date.now() + 60_000,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    // Stop immediately before the first tick fires
    hb.stop(message.id);

    // Wait past two check intervals — no posts should happen
    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts).toHaveLength(0);
  });

  // ── handled termination (polled status) ──────────────────────────────────

  it('heartbeat stops silently when message.status = handled', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      messageStatus: 'handled',
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    // No posts — message was already handled before heartbeat could act
    expect(posts).toHaveLength(0);
  });

  // ── stale termination (one-shot notice) ──────────────────────────────────

  it('soft-stale: posts "monitor not checked in" notice once postIntervalMs passes, no thinking copy', async () => {
    // attachmentStatus='stale' + cc_pid null → soft-stale branch (CC may still
    // be alive; no PID to prove death). Notice posts when (now - updated_at)
    // >= postIntervalMs.
    const { registry, attachment, message } = makeFixture(tmpDir, {
      attachmentStatus: 'stale',
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(() => posts.length >= 1, 3000);
    const stalePost = posts[0]!;
    expect(stalePost.text).toContain('monitor has not checked in');
    // Soft-stale must NEVER post the hard-dead "session appears terminated".
    expect(stalePost.text).not.toContain('session appears terminated');
  });

  it('hard-dead: cc_pid gone posts session-terminated notice via tryMarkStaleNoticePosted', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      attachmentStatus: 'stale',
      ccPid: 999_999, // bogus PID — isPidAlive override returns false anyway
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
      isPidAlive: () => false, // hard-dead
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(() => posts.length >= 1);
    expect(posts[0]!.text).toContain('session appears terminated');
    // Hard-dead must NEVER mention check-in latency.
    expect(posts[0]!.text).not.toContain('monitor has not checked in');
  });

  // ── ended termination ────────────────────────────────────────────────────

  it('ended: posts final message and stops', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      attachmentStatus: 'ended',
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(() => posts.length >= 1);
    expect(posts[0]!.text).toContain('attached session has ended');

    // No further posts after the final one
    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts).toHaveLength(1);
  });

  // ── errored termination ──────────────────────────────────────────────────

  it('errored: posts final message and stops', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      attachmentStatus: 'errored',
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(() => posts.length >= 1);
    expect(posts[0]!.text).toContain('encountered an error');

    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts).toHaveLength(1);
  });

  // ── 60-minute cap ────────────────────────────────────────────────────────

  it('60-minute cap: posts timeout message and stops', async () => {
    // createdAt in the distant past to trigger cap immediately
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000, // monitor healthy
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS, // 1000ms in tests
    });

    // Pass createdAt far in the past so elapsed > maxDurationMs immediately
    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: Date.now() - MAX_MS - 1000, // already past cap
    });

    await waitFor(() => posts.length >= 1);
    expect(posts[0]!.text).toContain('pending response timeout');

    // No further posts
    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts).toHaveLength(1);
  });

  // ── stale-then-recovered ─────────────────────────────────────────────────

  it('soft-stale-then-recovered: notice fires once after postIntervalMs, recovery is silent', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      attachmentStatus: 'stale',
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    // Wait for soft-stale notice (cc_pid null → soft path)
    await waitFor(
      () => posts.some((p) => p.text.includes('monitor has not checked in')),
      3000,
    );
    const postsAfterStale = posts.length;

    // Simulate monitor recovery: take over the stale slot (no prior owner, so this succeeds).
    // takeOverStaleMonitor sets status → 'active' and sets a healthy monitor_owner_expires_at.
    const now = Date.now();
    const takeOverResult = registry.takeOverStaleMonitor({
      attachmentId: attachment.id,
      newOwnerToken: 'tok-recovered',
      newPid: 1234,
      newStartedAt: now,
      ttlMs: 60_000,
      now,
    });
    expect(takeOverResult.ok).toBe(true);
    expect(registry.getAttachment(attachment.id)?.status).toBe('active');

    // Recovery must NOT post a fresh _thinking..._ banner. Wait long enough
    // for the heartbeat to tick at least once after recovery; the only new
    // post should be the eventual _still working..._ timer (postIntervalMs
    // after recovery), never a thinking banner.
    await new Promise((r) => setTimeout(r, CHECK_MS * 4));
    const newPosts = posts.slice(postsAfterStale);
    for (const p of newPosts) {
      expect(p.text).not.toContain('thinking');
    }
  });

  // ── PID-fast-stale ───────────────────────────────────────────────────────

  it('PID-fast-stale (hard-dead): cc_pid gone → status flips, session-terminated notice posts', async () => {
    // Claim with a far-future expires_at; PID probe is the only thing that
    // flips status. cc_pid set so the heartbeat can prove CC death.
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60 * 60_000,
      ccPid: 999_999,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
      isPidAlive: () => false, // every PID reads as dead
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(() =>
      posts.some((p) => p.text.includes('session appears terminated')),
    );
    expect(registry.getAttachment(attachment.id)?.status).toBe('stale');
  });

  it('hard-dead: one session-terminated notice per attachment, not N', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60 * 60_000,
      ccPid: 999_999,
    });
    const now = Date.now();

    const message2 = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '111.444',
      senderId: 'U_SEAN',
      text: 'second message',
      requiresResponse: true,
      now,
    });
    const message3 = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '111.555',
      senderId: 'U_SEAN',
      text: 'third message',
      requiresResponse: true,
      now,
    });

    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
      isPidAlive: () => false,
    });

    for (const m of [message, message2, message3]) {
      hb.start({
        messageId: m.id,
        attachmentId: attachment.id,
        channel: CHANNEL,
        threadTs: THREAD_TS,
        createdAt: m.created_at,
      });
    }

    await waitFor(() =>
      posts.some((p) => p.text.includes('session appears terminated')),
    );

    // Wait long enough for the other two heartbeats to tick — they MUST
    // observe stale_notice_posted_at != NULL and stay silent.
    await new Promise((r) => setTimeout(r, CHECK_MS * 4));

    const staleNotices = posts.filter((p) =>
      p.text.includes('session appears terminated'),
    );
    expect(staleNotices).toHaveLength(1);
  });

  it('soft-stale: monitor dead but cc_pid alive → "monitor has not checked in" with 5-min cadence', async () => {
    // ccPid is the live test process.pid; monitor will be claimed with a
    // bogus PID directly (no prior fixture claim).
    const { registry, attachment, message } = makeFixture(tmpDir, {
      ccPid: process.pid, // alive
    });
    registry.claimMonitorOwnership({
      attachmentId: attachment.id,
      ownerToken: 'test-monitor-tok',
      pid: 999_999, // bogus monitor PID
      startedAt: Date.now(),
      ttlMs: 60 * 60_000,
    });
    const { poster, posts } = makePoster();

    // isPidAlive: only process.pid is alive; everything else dead.
    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
      isPidAlive: (pid: number) => pid === process.pid,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(
      () => posts.some((p) => p.text.includes('monitor has not checked in')),
      3000,
    );
    const soft = posts.find((p) =>
      p.text.includes('monitor has not checked in'),
    )!;
    expect(soft.text).not.toContain('session appears terminated');
  });

  it('stale-notice flag is cleared on recovery so a future stale event posts again', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      attachmentStatus: 'stale',
    });

    // Simulate a notice was already posted for this stale period.
    expect(registry.tryMarkStaleNoticePosted(attachment.id)).toBe(true);
    expect(registry.tryMarkStaleNoticePosted(attachment.id)).toBe(false);

    // Recovery: takeover puts attachment back to active and clears the flag.
    const now = Date.now();
    const takeover = registry.takeOverStaleMonitor({
      attachmentId: attachment.id,
      newOwnerToken: 'tok-recovered',
      newPid: process.pid,
      newStartedAt: now,
      ttlMs: 60_000,
      now,
    });
    expect(takeover.ok).toBe(true);

    // After recovery, the flag should be NULL again — a new stale period can
    // post a fresh notice.
    expect(registry.tryMarkStaleNoticePosted(attachment.id)).toBe(true);

    // Reference message to satisfy lints — fixture's message exists in DB.
    expect(registry.getMessageById(message.id)).not.toBeNull();
  });

  // ── heartbeat never posts _thinking..._ on its own ──────────────────────

  it('does NOT post _thinking..._ — 📥 reaction is the only in-thread ack for non-mention messages', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: 60_000, // long — we want to assert quiet, not "still working"
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await new Promise((r) => setTimeout(r, CHECK_MS * 4));
    expect(posts.filter((p) => p.text.includes('thinking'))).toHaveLength(0);
  });

  // ── quiet when monitor not healthy ──────────────────────────────────────

  it('stays quiet (no posts) when monitor is not yet healthy and message not emitted', async () => {
    // No monitor owner → monitor not healthy
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: undefined,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    // Wait through two check intervals
    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts).toHaveLength(0);
  });

  // ── repeating _still working..._ posts ──────────────────────────────────

  it('posts repeating _still working..._ for slow work (no thinking ever)', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000, // monitor healthy
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS, // 200ms — short for tests
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    await waitFor(
      () => posts.some((p) => p.text.includes('still working')),
      3000,
    );
    // No _thinking..._ post should appear at all.
    expect(posts.filter((p) => p.text.includes('thinking'))).toHaveLength(0);
  });

  // ── suppression when agent recently active ──────────────────────────────

  it('suppresses _still working..._ when recordAgentActivity fired within postIntervalMs', async () => {
    // Simulates: user message lands → agent posts a status mid-flight →
    // heartbeat tick comes due → should stay quiet because the status itself
    // is already the liveness signal. Without this gate, the heartbeat fires
    // on top of every status post and clutters the thread.
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    // Simulate the agent posting a status right before the first tick fires.
    // The heartbeat will become due (postIntervalMs since lastPostTime) but
    // see recent activity and suppress.
    const tickRefreshHandle = setInterval(() => {
      registry.recordAgentActivity(attachment.id, Date.now());
    }, POST_MS / 4);

    try {
      // Wait long enough that, without suppression, multiple heartbeats would
      // have fired (3× postIntervalMs).
      await new Promise((r) => setTimeout(r, POST_MS * 3));
      expect(posts.filter((p) => p.text.includes('still working'))).toEqual([]);
    } finally {
      clearInterval(tickRefreshHandle);
    }

    // Once the agent goes quiet, the next tick should be allowed to post.
    await waitFor(
      () => posts.some((p) => p.text.includes('still working')),
      POST_MS * 3,
    );
  });

  // ── parallel heartbeats serialize via recordAgentActivity ────────────────

  it('two pending messages on one attachment collapse to one _still working..._ per cycle', async () => {
    // Without serialization, each pending message's heartbeat fires
    // independently on its own 5-min cadence → user sees stacked
    // "still working" posts (one per pending message) every 5 min. Fix
    // records agent activity on each heartbeat post, so the second
    // heartbeat's tick sees the first's activity and suppresses.
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000,
    });
    // Second pending message on the same attachment.
    const message2 = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '111.444',
      senderId: 'U_SEAN',
      text: 'one sec',
      requiresResponse: true,
      now: Date.now(),
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });
    hb.start({
      messageId: message2.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message2.created_at,
    });

    // First post fires shortly after postIntervalMs. The other heartbeat's
    // tick fires soon after but sees recent activity and stays quiet. Wait
    // enough for both heartbeats' ticks to fire (a few check intervals after
    // the first post) but well under the next postIntervalMs window — past
    // that, both would legitimately become eligible again.
    await waitFor(
      () => posts.some((p) => p.text.includes('still working')),
      POST_MS * 4,
    );
    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts.filter((p) => p.text.includes('still working'))).toHaveLength(
      1,
    );
  });

  // ── no-op for duplicate start ────────────────────────────────────────────

  it('start() is idempotent — second call for same messageId is a no-op', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    const params = {
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    };

    hb.start(params);
    hb.start(params); // second call — no-op

    // First user-visible post is the _still working..._ timer; wait for it.
    await waitFor(
      () => posts.some((p) => p.text.includes('still working')),
      3000,
    );
    // Idempotency means the second start did not double-register a tick loop:
    // we expect exactly one heartbeat post in the window (could be 1+ over
    // long waits, but in this short test window it should be 1).
    const stillWorkingPosts = posts.filter((p) =>
      p.text.includes('still working'),
    );
    expect(stillWorkingPosts.length).toBe(1);
  });

  // ── stopAll cleans up all entries ────────────────────────────────────────

  it('stopAll() stops all active heartbeats', async () => {
    const { registry, attachment, message } = makeFixture(tmpDir, {
      monitorExpiresAt: Date.now() + 60_000,
    });
    const { poster, posts } = makePoster();

    hb = createHeartbeatManager({
      registry,
      poster,
      checkIntervalMs: CHECK_MS,
      postIntervalMs: POST_MS,
      maxDurationMs: MAX_MS,
    });

    hb.start({
      messageId: message.id,
      attachmentId: attachment.id,
      channel: CHANNEL,
      threadTs: THREAD_TS,
      createdAt: message.created_at,
    });

    hb.stopAll();

    // Wait — no posts should happen after stopAll
    await new Promise((r) => setTimeout(r, CHECK_MS * 3));
    expect(posts).toHaveLength(0);
  });
});

