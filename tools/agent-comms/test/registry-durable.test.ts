import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableRegistry } from '../src/registry';
import {
  createDurableRegistry,
  LEASE_TTL_MS,
  STALE_THRESHOLD_MS,
} from '../src/registry';

// ---- Test helpers ----

function makeTmp(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), 'actest-durable-'));
  return { dir, db: join(dir, 'registry.db') };
}

function makeAttachment(
  reg: DurableRegistry,
  overrides: Partial<{
    channelId: string;
    threadTs: string;
    cwd: string;
    machineId: string;
    ownerMode: 'terminal-attached' | 'daemon-spawned';
    now: number;
  }> = {},
) {
  return reg.createOrReuseAttachment({
    channelId: overrides.channelId ?? 'C001',
    threadTs: overrides.threadTs ?? '1000.000',
    cwd: overrides.cwd ?? '/tmp',
    machineId: overrides.machineId ?? 'mac-mini',
    ownerMode: overrides.ownerMode ?? 'terminal-attached',
    now: overrides.now,
  });
}

// ---- Tests ----

describe('createDurableRegistry', () => {
  let tmp: { dir: string; db: string };
  let reg: DurableRegistry;

  beforeEach(() => {
    tmp = makeTmp();
    reg = createDurableRegistry({ dbPath: tmp.db });
  });

  afterEach(() => {
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ 1 ----
  describe('schema-init idempotency', () => {
    it('creates tables on first open and does not error on second open', () => {
      // First open happens in beforeEach. Open a second registry on same path.
      const reg2 = createDurableRegistry({ dbPath: tmp.db });

      // Both should be able to operate without errors.
      const att1 = makeAttachment(reg);
      const att2 = makeAttachment(reg2, { threadTs: '2000.000' });
      expect(att1.status).toBe('active');
      expect(att2.status).toBe('active');
    });

    it('preserves existing rows across re-open', () => {
      const att = makeAttachment(reg);
      const reg2 = createDurableRegistry({ dbPath: tmp.db });
      const found = reg2.createOrReuseAttachment({
        channelId: att.channel_id,
        threadTs: att.thread_ts,
        cwd: att.cwd,
        machineId: att.machine_id,
        ownerMode: 'terminal-attached',
      });
      expect(found.id).toBe(att.id);
    });
  });

  // ------------------------------------------------------------------ 2 ----
  describe('migration from handoffs-only db', () => {
    it('adds attachments/messages tables without dropping handoffs rows', () => {
      const { dir } = makeTmp();
      const dbPath = join(dir, 'legacy.db');

      // Build a db with only the v1 handoffs schema + data.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE handoffs (
          thread_ts TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          opened_at INTEGER NOT NULL,
          last_turn_at INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          meta_json TEXT
        );
        INSERT INTO handoffs VALUES ('ts-legacy', 'C1', 'sess1', '/tmp', 'mac', 1, NULL, 'active', NULL);
      `);
      raw.close();

      // Open with durable registry — should migrate without errors.
      const durReg = createDurableRegistry({ dbPath });

      // Legacy handoff row must survive.
      const handoff = durReg.findByThreadTs('ts-legacy');
      expect(handoff).not.toBeNull();
      expect(handoff!.session_id).toBe('sess1');

      // New tables must work.
      const att = makeAttachment(durReg);
      expect(att.id).toBeDefined();
      expect(att.status).toBe('active');

      // Cleanup
      rmSync(dir, { recursive: true, force: true });
    });
  });

  // ------------------------------------------------------------------ 3 ----
  describe('createOrReuseAttachment', () => {
    it('creates a new attachment with expected defaults', () => {
      const now = 5000;
      const att = reg.createOrReuseAttachment({
        channelId: 'C001',
        threadTs: '1.0',
        cwd: '/project',
        machineId: 'mini',
        ownerMode: 'terminal-attached',
        now,
      });

      expect(att.channel_id).toBe('C001');
      expect(att.thread_ts).toBe('1.0');
      expect(att.status).toBe('active');
      expect(att.agent_runtime).toBe('claude-code');
      expect(att.delivery_adapter).toBe('monitor');
      expect(att.owner_mode).toBe('terminal-attached');
      expect(att.created_at).toBe(now);
      expect(att.monitor_owner).toBeNull();
    });

    it('reuses the active attachment for the same (channel_id, thread_ts)', () => {
      const first = makeAttachment(reg);
      const second = makeAttachment(reg); // same defaults
      expect(second.id).toBe(first.id);
    });

    it('creates a distinct attachment for a different thread_ts', () => {
      const a1 = makeAttachment(reg, { threadTs: '1.0' });
      const a2 = makeAttachment(reg, { threadTs: '2.0' });
      expect(a2.id).not.toBe(a1.id);
    });

    it('creates a new attachment after the previous one is ended', () => {
      const first = makeAttachment(reg);
      reg.markAttachmentStale(first.id);
      // Marking stale changes status — no longer active, so a new one can be created.
      const second = makeAttachment(reg);
      expect(second.id).not.toBe(first.id);
    });
  });

  // ------------------------------------------------------------------ 4 ----
  describe('Slack-ts dedup via constraint', () => {
    it('inserts an inbound message with a slack_ts', () => {
      const att = makeAttachment(reg);
      const msg = reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        slackTs: '9999.0001',
        senderId: 'U123',
        text: 'hello',
        requiresResponse: true,
      });
      expect(msg.slack_ts).toBe('9999.0001');
      expect(msg.status).toBe('persisted');
      expect(msg.requires_response).toBe(1);
    });

    it('throws a UNIQUE constraint error on duplicate slack_ts — not a procedural check', () => {
      const att = makeAttachment(reg);
      const params = {
        attachmentId: att.id,
        direction: 'slack_to_agent' as const,
        slackTs: '8888.0001',
        text: 'dup',
      };
      reg.insertInboundMessage(params);

      // Second insert with same (attachment_id, slack_ts) must throw from the index.
      expect(() => reg.insertInboundMessage(params)).toThrow(
        /UNIQUE constraint failed/,
      );
    });

    it('allows the same slack_ts on a different attachment', () => {
      const att1 = makeAttachment(reg, { threadTs: 'thread-A' });
      const att2 = makeAttachment(reg, { threadTs: 'thread-B' });
      const slackTs = '7777.0001';

      const m1 = reg.insertInboundMessage({
        attachmentId: att1.id,
        direction: 'slack_to_agent',
        slackTs,
        text: 'msg1',
      });
      const m2 = reg.insertInboundMessage({
        attachmentId: att2.id,
        direction: 'slack_to_agent',
        slackTs,
        text: 'msg2',
      });
      expect(m1.id).not.toBe(m2.id);
    });

    it('allows two messages with null slack_ts on the same attachment', () => {
      const att = makeAttachment(reg);
      const m1 = reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'no-ts-1',
      });
      const m2 = reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'no-ts-2',
      });
      expect(m1.id).not.toBe(m2.id);
    });

    it('messages.attachment_id FK rejects insert against a nonexistent attachment', () => {
      // PRAGMA foreign_keys = ON is set on createDurableRegistry; insertion
      // with a missing attachment_id must throw a FK constraint failure.
      expect(() =>
        reg.insertInboundMessage({
          attachmentId: 'no-such-attachment',
          direction: 'slack_to_agent',
          text: 'orphan',
        }),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  // ------------------------------------------------------------------ 5 ----
  describe('message lease → emit → handle lifecycle', () => {
    it('leases a persisted message and transitions it to leased', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });

      const [leased] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
      });
      expect(leased).toBeDefined();
      expect(leased.status).toBe('leased');
      expect(leased.lease_holder).toBe('tok1');
      expect(leased.lease_expires_at).toBeGreaterThan(Date.now());
    });

    it('markMessageEmitted transitions leased → emitted', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });
      const [leased] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
      });

      const ok = reg.markMessageEmitted({
        messageId: leased.id,
        ownerToken: 'tok1',
      });
      expect(ok).toBe(true);
    });

    it('markMessageEmitted fails if called with wrong ownerToken', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });
      const [leased] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
      });

      const ok = reg.markMessageEmitted({
        messageId: leased.id,
        ownerToken: 'wrong-tok',
      });
      expect(ok).toBe(false);
    });

    it('markMessageHandled transitions emitted → handled', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });
      const [leased] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
      });
      reg.markMessageEmitted({ messageId: leased.id, ownerToken: 'tok1' });

      const ok = reg.markMessageHandled({
        attachmentId: att.id,
        messageId: leased.id,
      });
      expect(ok).toBe(true);
    });

    it('markMessageHandled is idempotent on a handled message', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });
      const [leased] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
      });
      reg.markMessageHandled({ attachmentId: att.id, messageId: leased.id });

      // Second call returns false (already terminal)
      const ok2 = reg.markMessageHandled({
        attachmentId: att.id,
        messageId: leased.id,
      });
      expect(ok2).toBe(false);
    });

    it('markMessageHandled rejects cross-attachment requests (does not transition)', () => {
      // Two attachments, one message. Calling markMessageHandled with the
      // WRONG attachment_id must NOT transition the message — otherwise
      // /reply could close another attachment's message and corrupt the
      // (attachment_id, message_id) idempotency contract.
      const att1 = makeAttachment(reg);
      const att2 = makeAttachment(reg, {
        channelId: 'C_other',
        threadTs: `${Math.random().toString(36).slice(2)}.999`,
      });
      const msg = reg.insertInboundMessage({
        attachmentId: att1.id,
        direction: 'slack_to_agent',
        text: 'belongs to att1',
      });

      const ok = reg.markMessageHandled({
        attachmentId: att2.id, // wrong attachment
        messageId: msg.id,
      });
      expect(ok).toBe(false);

      // Message status should still be persisted (untouched)
      const after = reg.getMessageById(msg.id);
      expect(after?.status).toBe('persisted');

      // Calling with the correct attachment still works
      const ok2 = reg.markMessageHandled({
        attachmentId: att1.id,
        messageId: msg.id,
      });
      expect(ok2).toBe(true);
    });

    it('leaseNextMessages returns empty when all messages are leased', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });
      reg.leaseNextMessages({ attachmentId: att.id, ownerToken: 'tok1' });

      const second = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok2',
      });
      expect(second).toHaveLength(0);
    });

    it('markMessageFailed marks a message as failed', () => {
      const att = makeAttachment(reg);
      const msg = reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });
      const ok = reg.markMessageFailed({
        messageId: msg.id,
        error: 'adapter_down',
      });
      expect(ok).toBe(true);
    });
  });

  // ------------------------------------------------------------------ 6 ----
  describe('lease-expiry reclaim', () => {
    it('expireStaleLeases returns leased messages with expired TTL to persisted', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'expiry-test',
      });

      const base = 1_000_000;
      reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
        leaseTtlMs: LEASE_TTL_MS,
        now: base,
      });

      // Before expiry: nothing reclaimed
      const before = reg.expireStaleLeases(base + LEASE_TTL_MS - 1);
      expect(before).toHaveLength(0);

      // After expiry: the leased message is reclaimed
      const after = reg.expireStaleLeases(base + LEASE_TTL_MS + 1);
      expect(after).toHaveLength(1);

      // Message can now be leased again
      const releasedMsg = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok2',
        now: base + LEASE_TTL_MS + 2,
      });
      expect(releasedMsg).toHaveLength(1);
      expect(releasedMsg[0].lease_holder).toBe('tok2');
    });

    it('does not reclaim messages with non-expired leases', () => {
      const att = makeAttachment(reg);
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
      });

      const base = 2_000_000;
      reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok1',
        now: base,
      });

      // Well before expiry
      const reclaimed = reg.expireStaleLeases(base + 100);
      expect(reclaimed).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ 7 ----
  describe('monitor-owner stale → takeover replay', () => {
    it('claimMonitorOwnership sets ownership on a fresh attachment', () => {
      const att = makeAttachment(reg);
      const result = reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1234,
        startedAt: 1000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.ownerToken).toBe('owner1');
    });

    it('claimMonitorOwnership returns already_owned when a healthy owner exists', () => {
      const att = makeAttachment(reg);
      const base = 3_000_000;
      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });

      const second = reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner2',
        pid: 2,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base + 1_000, // 1s later, still within stale threshold
      });

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe('already_owned');
      if (second.reason === 'not_found') return;
      expect(second.existingToken).toBe('owner1');
    });

    it('claimMonitorOwnership returns stale_existing (not silent overwrite) when owner is expired', () => {
      // Strict claim: expired-owner replacement must route through
      // takeOverStaleMonitor so in-flight `leased` messages get reclaimed.
      // If claim silently overwrote, those messages would stay leased to
      // the dead owner and a fresh monitor's first long-poll would see
      // nothing to deliver.
      const att = makeAttachment(reg);
      const base = 3_500_000;
      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });

      // Past stale threshold
      const staleNow = base + STALE_THRESHOLD_MS + 1;
      const result = reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner2',
        pid: 2,
        startedAt: staleNow,
        ttlMs: STALE_THRESHOLD_MS,
        now: staleNow,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('stale_existing');
      if (result.reason === 'not_found') return;
      expect(result.existingToken).toBe('owner1');
    });

    it('takeOverStaleMonitor returns not_stale when current owner is healthy', () => {
      const att = makeAttachment(reg);
      const base = 4_000_000;
      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });

      const result = reg.takeOverStaleMonitor({
        attachmentId: att.id,
        newOwnerToken: 'owner2',
        newPid: 2,
        newStartedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base + 1_000, // still within stale window
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('not_stale');
    });

    it('takeOverStaleMonitor reclaims in-flight leased messages and sets new owner', () => {
      const att = makeAttachment(reg);
      const base = 5_000_000;

      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });

      // Insert and lease a message under owner1
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg-in-flight',
        now: base,
      });
      const [leasedMsg] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'owner1',
        now: base,
      });
      expect(leasedMsg.status).toBe('leased');

      // Advance time past stale threshold — owner1 is now stale
      const staleNow = base + STALE_THRESHOLD_MS + 1;

      const result = reg.takeOverStaleMonitor({
        attachmentId: att.id,
        newOwnerToken: 'owner2',
        newPid: 2,
        newStartedAt: staleNow,
        ttlMs: STALE_THRESHOLD_MS,
        now: staleNow,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.ownerToken).toBe('owner2');
      expect(result.reclaimedMessageIds).toContain(leasedMsg.id);

      // The message must be back at persisted so owner2 can pick it up
      const re_leased = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'owner2',
        now: staleNow + 1,
      });
      expect(re_leased).toHaveLength(1);
      expect(re_leased[0].id).toBe(leasedMsg.id);
      expect(re_leased[0].lease_holder).toBe('owner2');
    });

    it('monitorCheckin refreshes ownership expiry and returns true on token match', () => {
      const att = makeAttachment(reg);
      const base = 6_000_000;
      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });

      const checkedIn = reg.monitorCheckin({
        attachmentId: att.id,
        ownerToken: 'owner1',
        now: base + 15_000,
      });
      expect(checkedIn).toBe(true);
    });

    it('monitorCheckin returns false on token mismatch', () => {
      const att = makeAttachment(reg);
      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'owner1',
        pid: 1,
        startedAt: 1000,
      });
      const ok = reg.monitorCheckin({
        attachmentId: att.id,
        ownerToken: 'wrong-owner',
      });
      expect(ok).toBe(false);
    });
  });

  // ------------------------------------------------------------------ 8 ----
  describe('reconcileOnStartup after crash mid-lease', () => {
    it('clears expired monitor ownership and reclaims leased messages', () => {
      const att = makeAttachment(reg);
      const base = 7_000_000;

      // Claim ownership, lease a message — then "crash" (just close/reopen db).
      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'crash-owner',
        pid: 9999,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'orphaned',
        now: base,
      });
      reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'crash-owner',
        leaseTtlMs: LEASE_TTL_MS,
        now: base,
      });

      // Reopen the registry (simulate daemon restart)
      const reg2 = createDurableRegistry({ dbPath: tmp.db });

      // Advance time past both stale threshold and lease TTL
      const restartNow =
        base + Math.max(STALE_THRESHOLD_MS, LEASE_TTL_MS) + 1_000;

      const result = reg2.reconcileOnStartup(restartNow);

      expect(result.expiredMonitorOwners).toContain(att.id);
      expect(result.reclaimedMessageIds).toHaveLength(1);

      // Monitor ownership cleared
      // (Re-query via a fresh lease claim which should succeed since owner is cleared)
      const claim = reg2.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'new-owner',
        pid: 1,
        startedAt: restartNow,
        now: restartNow,
      });
      expect(claim.ok).toBe(true);

      // Message is back at persisted, can be leased again
      const msgs = reg2.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'new-owner',
        now: restartNow + 1,
      });
      expect(msgs).toHaveLength(1);
    });

    it('reconcileOnStartup is a no-op when nothing is expired', () => {
      const att = makeAttachment(reg);
      const base = 8_000_000;

      reg.claimMonitorOwnership({
        attachmentId: att.id,
        ownerToken: 'healthy-owner',
        pid: 1,
        startedAt: base,
        ttlMs: STALE_THRESHOLD_MS,
        now: base,
      });
      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'msg',
        now: base,
      });
      reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'healthy-owner',
        leaseTtlMs: LEASE_TTL_MS,
        now: base,
      });

      // Reconcile while still within both TTLs
      const result = reg.reconcileOnStartup(base + 100);

      expect(result.expiredMonitorOwners).toHaveLength(0);
      expect(result.reclaimedMessageIds).toHaveLength(0);
    });

    it('leaves handled messages untouched during reconcile', () => {
      const att = makeAttachment(reg);
      const base = 9_000_000;

      reg.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        text: 'already done',
        now: base,
      });
      const [msg] = reg.leaseNextMessages({
        attachmentId: att.id,
        ownerToken: 'tok',
        now: base,
      });
      reg.markMessageHandled({
        attachmentId: att.id,
        messageId: msg.id,
        now: base + 1,
      });

      // Reconcile past both TTLs
      const result = reg.reconcileOnStartup(base + STALE_THRESHOLD_MS + 10_000);

      // handled message must NOT appear in reclaimed list
      expect(result.reclaimedMessageIds).not.toContain(msg.id);
    });
  });

  // ------------------------------------------------------------------ misc --
  describe('recordAgentActivity', () => {
    it('updates last_agent_activity_at on the attachment', () => {
      const att = makeAttachment(reg);
      expect(att.last_agent_activity_at).toBeNull();

      reg.recordAgentActivity(att.id, 12345);

      // Verify via a fresh createOrReuseAttachment call — attachment is re-fetched
      // by seeing whether the field changed. Use a direct DB read via re-insert
      // to the same attachment to get the updated row.
      const same = reg.createOrReuseAttachment({
        channelId: att.channel_id,
        threadTs: att.thread_ts,
        cwd: att.cwd,
        machineId: att.machine_id,
        ownerMode: 'terminal-attached',
      });
      expect(same.last_agent_activity_at).toBe(12345);
    });
  });

  // ------------------------------------------------------------------ handoffs compat --
  // The shared handoffs methods (buildRegistryMethods) back both this durable
  // registry and the legacy createRegistry factory / module-level singleton
  // (still consumed by the /health route via countByStatus), so the behavioral
  // coverage lives here.
  describe('legacy handoffs API still works', () => {
    function insertHandoff(
      threadTs: string,
      sessionId: string,
      openedAt = 1,
    ): void {
      reg.insertHandoff({
        thread_ts: threadTs,
        channel_id: 'C999',
        session_id: sessionId,
        cwd: '/cwd',
        machine_id: 'mac',
        opened_at: openedAt,
      });
    }

    it('insertHandoff and findByThreadTs are functional', () => {
      insertHandoff('compat-ts', 'sess-x');
      const row = reg.findByThreadTs('compat-ts');
      expect(row).not.toBeNull();
      expect(row!.session_id).toBe('sess-x');
      expect(row!.channel_id).toBe('C999');
      expect(row!.status).toBe('active');
    });

    it('findByThreadTs returns null for unknown thread_ts', () => {
      expect(reg.findByThreadTs('unknown')).toBeNull();
    });

    it('finds active by session_id, returns most recently opened', () => {
      insertHandoff('hand-ts1', 'sess-1', 1000);
      insertHandoff('hand-ts2', 'sess-1', 2000);

      const row = reg.findActiveBySessionId('sess-1');
      expect(row).not.toBeNull();
      expect(row!.thread_ts).toBe('hand-ts2'); // most recent
    });

    it('findActiveBySessionId returns null for ended session', () => {
      insertHandoff('hand-ts1', 'sess-2');
      reg.markStatus('hand-ts1', 'ended');

      expect(reg.findActiveBySessionId('sess-2')).toBeNull();
    });

    it('markStatus transitions correctly', () => {
      insertHandoff('hand-ts1', 'sess-3');

      reg.markStatus('hand-ts1', 'errored');
      expect(reg.findByThreadTs('hand-ts1')!.status).toBe('errored');

      reg.markStatus('hand-ts1', 'active');
      expect(reg.findByThreadTs('hand-ts1')!.status).toBe('active');

      reg.markStatus('hand-ts1', 'ended');
      expect(reg.findByThreadTs('hand-ts1')!.status).toBe('ended');
    });

    it('markLastTurn updates last_turn_at', () => {
      insertHandoff('hand-ts1', 'sess-4');

      const before = reg.findByThreadTs('hand-ts1')!;
      expect(before.last_turn_at).toBeNull();

      reg.markLastTurn('hand-ts1', 9999);
      const after = reg.findByThreadTs('hand-ts1')!;
      expect(after.last_turn_at).toBe(9999);
    });

    it('countByStatus counts correctly', () => {
      expect(reg.countByStatus('active')).toBe(0);

      insertHandoff('hand-ts1', 's1', 1);
      insertHandoff('hand-ts2', 's2', 2);
      expect(reg.countByStatus('active')).toBe(2);

      reg.markStatus('hand-ts1', 'ended');
      expect(reg.countByStatus('active')).toBe(1);
      expect(reg.countByStatus('ended')).toBe(1);
    });
  });
});

