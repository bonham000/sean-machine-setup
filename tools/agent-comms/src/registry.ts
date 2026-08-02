import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_DB_PATH = join(
  homedir(),
  '.claude',
  'agent-comms',
  'registry.db',
);

// ====== Legacy (v1) types — unchanged ======

export type HandoffStatus = 'active' | 'ended' | 'errored';

export interface HandoffRow {
  thread_ts: string;
  channel_id: string;
  session_id: string;
  cwd: string;
  machine_id: string;
  opened_at: number;
  last_turn_at: number | null;
  status: HandoffStatus;
  meta_json: string | null;
}

export interface InsertHandoff {
  thread_ts: string;
  channel_id: string;
  session_id: string;
  cwd: string;
  machine_id: string;
  opened_at: number;
}

export interface Registry {
  insertHandoff(row: InsertHandoff): void;
  findByThreadTs(threadTs: string): HandoffRow | null;
  findActiveBySessionId(sessionId: string): HandoffRow | null;
  markStatus(threadTs: string, status: HandoffStatus): void;
  markLastTurn(threadTs: string, ts?: number): void;
  countByStatus(status?: HandoffStatus): number;
}

// ====== Durable state constants ======

export const STALE_THRESHOLD_MS = 60_000;
export const LEASE_TTL_MS = 30_000;

// ====== Attachment types ======

export type AttachmentStatus = 'active' | 'stale' | 'ended' | 'errored';
export type OwnerMode = 'terminal-attached' | 'daemon-spawned';
export type DeliveryAdapter = 'monitor' | 'channel' | 'daemon-worker';

export interface AttachmentRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  session_id: string | null;
  cwd: string;
  machine_id: string;
  agent_runtime: string;
  delivery_adapter: string;
  owner_mode: string;
  status: AttachmentStatus;
  last_seen_at: number | null;
  last_agent_activity_at: number | null;
  monitor_owner: string | null;
  monitor_owner_pid: number | null;
  monitor_owner_started_at: number | null;
  monitor_owner_last_seen_at: number | null;
  monitor_owner_expires_at: number | null;
  /**
   * PID of the parent Claude Code session process that ran
   * `/slack-attach-session`. Used by the heartbeat to distinguish hard-dead
   * (CC PID gone — definitive session-terminated signal) from soft-stale
   * (monitor unresponsive but CC alive — wait 5 min before notifying).
   * Null on legacy attachments created before this column was plumbed.
   */
  cc_pid: number | null;
  /**
   * Unix ms when the daemon last posted the HARD-DEAD notice for this
   * attachment. NULL when no hard-dead notice has been posted for the
   * current stale period. CAS gate is one-shot — cleared on recovery.
   */
  stale_notice_posted_at: number | null;
  /**
   * Unix ms when the daemon last posted a SOFT-STALE notice (monitor
   * unresponsive but CC alive). Recurring 5-min cadence: posts again
   * once `now - last_soft_stale_notice_at >= 5 min`. Cleared on recovery.
   */
  last_soft_stale_notice_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateAttachmentParams {
  channelId: string;
  threadTs: string;
  sessionId?: string | null;
  cwd: string;
  machineId: string;
  agentRuntime?: string;
  deliveryAdapter?: DeliveryAdapter;
  ownerMode: OwnerMode;
  /**
   * PID of the parent CC session process. Optional — passed by the slash
   * command. When set, the heartbeat uses it to distinguish hard-dead from
   * soft-stale. Reuse semantics: if a row already exists for the same
   * (channel, thread_ts) and the caller supplies a fresh cc_pid, the stored
   * row is updated to the new PID (a re-attach inside a new CC session).
   */
  ccPid?: number | null;
  now?: number;
}

// ====== Message types ======

export type MessageDirection = 'slack_to_agent' | 'agent_to_slack';
export type MessageStatus =
  | 'persisted'
  | 'leased'
  | 'emitted'
  | 'handled'
  | 'failed'
  | 'stale';

export interface MessageRow {
  id: string;
  attachment_id: string;
  direction: MessageDirection;
  slack_ts: string | null;
  sender_id: string | null;
  text: string;
  requires_response: number; // SQLite boolean: 0 or 1
  status: MessageStatus;
  lease_holder: string | null;
  lease_expires_at: number | null;
  error: string | null;
  created_at: number;
  emitted_at: number | null;
  handled_at: number | null;
}

export interface LeasedMessageRow extends MessageRow {
  status: 'leased';
  lease_holder: string;
  lease_expires_at: number;
}

export interface InsertMessageParams {
  attachmentId: string;
  direction: MessageDirection;
  slackTs?: string | null;
  senderId?: string | null;
  text: string;
  requiresResponse?: boolean;
  now?: number;
}

// ====== Monitor ownership result types ======

export type ClaimMonitorResult =
  | { ok: true; ownerToken: string }
  | {
      ok: false;
      // 'already_owned' = healthy owner holds the slot (caller should 409).
      // 'stale_existing' = owner row present but expired; caller MUST route
      //   through takeOverStaleMonitor to reclaim in-flight leased messages.
      reason: 'already_owned' | 'stale_existing';
      existingToken: string;
      existingPid: number | null;
      existingStartedAt: number | null;
    }
  | { ok: false; reason: 'not_found' };

export type TakeOverResult =
  | { ok: true; ownerToken: string; reclaimedMessageIds: string[] }
  | { ok: false; reason: 'not_stale' | 'not_found' };

export type ReplaceMonitorOwnerResult =
  | { ok: true; ownerToken: string; reclaimedMessageIds: string[] }
  | { ok: false; reason: 'not_owner' | 'not_found' };

export interface ReconcileResult {
  /** Attachment ids whose expired monitor ownership was cleared. */
  expiredMonitorOwners: string[];
  /** Message ids returned from leased → persisted due to expired lease TTL. */
  reclaimedMessageIds: string[];
}

// ====== DurableRegistry interface ======

export interface DurableRegistry extends Registry {
  createOrReuseAttachment(params: CreateAttachmentParams): AttachmentRow;

  /** Return a single attachment by id, or null if not found. */
  getAttachment(id: string): AttachmentRow | null;

  /** Return all attachments with status === 'active'. Used by the error-watchdog sweep. */
  listActiveAttachments(): AttachmentRow[];

  /**
   * Record that the error watchdog has actioned a given API-error `requestId`
   * for an attachment. Returns true when this is the FIRST time (row inserted)
   * — the caller should then fire the notify + nudge. Returns false when the
   * (attachment_id, request_id) pair already exists (already actioned). The
   * primary key makes this atomic and idempotent: exactly one alert per error.
   */
  tryRecordWatchdogError(
    attachmentId: string,
    requestId: string,
    now?: number,
  ): boolean;

  /** Find an active attachment for (channelId, threadTs). Returns null if not found or not active. */
  findActiveAttachmentByChannelThread(
    channelId: string,
    threadTs: string,
  ): AttachmentRow | null;

  /**
   * Find a routable durable attachment for (channelId, threadTs) — `active`
   * OR `stale` (the design says stale attachments must still receive
   * inbound messages so the daemon can post a stale-status notice
   * instead of silently dropping the reply). Returns null if not found
   * or in a terminal status (`ended` / `errored`).
   */
  findRoutableAttachmentByChannelThread(
    channelId: string,
    threadTs: string,
  ): AttachmentRow | null;

  /** Find an active attachment by session_id. Returns null if not found or not active. */
  findActiveAttachmentBySessionId(sessionId: string): AttachmentRow | null;

  /**
   * Find a routable attachment by session_id — `active` OR `stale`. Used by
   * `/post` (via `resolveOrCreateThread`) so outbound CC→Slack posts route
   * into the existing attachment thread even when the monitor briefly
   * stopped checking in. Stale-attachment routing parity with the inbound
   * path (`findRoutableAttachmentByChannelThread`). Returns null if not
   * found or in a terminal status (`ended` / `errored`).
   */
  findRoutableAttachmentBySessionId(sessionId: string): AttachmentRow | null;

  /**
   * Find all active attachments whose monitor_owner_expires_at has passed and
   * mark them stale. Returns the IDs that were transitioned.
   */
  sweepStaleAttachments(now?: number): string[];

  claimMonitorOwnership(params: {
    attachmentId: string;
    ownerToken: string;
    pid: number;
    startedAt: number;
    ttlMs?: number;
    now?: number;
  }): ClaimMonitorResult;

  monitorCheckin(params: {
    attachmentId: string;
    ownerToken: string;
    ttlMs?: number;
    now?: number;
  }): boolean;

  replaceMonitorOwner(params: {
    attachmentId: string;
    ownerToken: string;
    pid: number;
    startedAt: number;
    ttlMs?: number;
    now?: number;
    reclaimLeases?: boolean;
  }): ReplaceMonitorOwnerResult;

  markAttachmentStale(attachmentId: string, now?: number): void;
  /**
   * Set session_id on an existing attachment. Used by daemon-spawned attachments
   * (e.g. @-mention path) where the row is created before CC's first turn and
   * the session_id is filled in only after CC exits and reports it back.
   */
  setAttachmentSessionId(attachmentId: string, sessionId: string): void;
  markAttachmentEnded(attachmentId: string): void;
  markAttachmentErrored(attachmentId: string): void;

  /**
   * Compare-and-set on `stale_notice_posted_at`. Returns true exactly once per
   * hard-dead period — the caller that observes true should post the
   * session-terminated notice; all other callers receive false and stay
   * silent. The flag is cleared when an attachment returns to `active` via
   * the monitor-ownership routes.
   */
  tryMarkStaleNoticePosted(attachmentId: string, now?: number): boolean;

  /**
   * Recurring CAS for soft-stale (monitor unresponsive but CC alive).
   * Returns true when `last_soft_stale_notice_at` is NULL or older than
   * `intervalMs` ago; updates the column to `now` on success. The caller
   * uses this to gate the 5-min-cadence "monitor not responding" notice.
   */
  tryMarkSoftStaleNotice(
    attachmentId: string,
    intervalMs: number,
    now?: number,
  ): boolean;

  /**
   * Clear both stale-notice flags (called when a monitor reclaims ownership)
   * so future stale events post a fresh notice.
   */
  clearStaleNoticePosted(attachmentId: string): void;

  takeOverStaleMonitor(params: {
    attachmentId: string;
    newOwnerToken: string;
    newPid: number;
    newStartedAt: number;
    ttlMs?: number;
    now?: number;
  }): TakeOverResult;

  insertInboundMessage(params: InsertMessageParams): MessageRow;

  /** Return a single message by id, or null if not found. */
  getMessageById(id: string): MessageRow | null;

  leaseNextMessages(params: {
    attachmentId: string;
    ownerToken: string;
    leaseTtlMs?: number;
    limit?: number;
    now?: number;
  }): LeasedMessageRow[];

  markMessageEmitted(params: {
    messageId: string;
    ownerToken: string;
    now?: number;
  }): boolean;

  /**
   * Transition a message to `handled`. Scoped to `(attachment_id, message_id)`
   * so a request mismatching the attachment cannot close another attachment's
   * message (which would corrupt the egress idempotency contract). Returns
   * true when the row transitioned, false when it was already handled OR
   * when (attachmentId, messageId) does not match a row.
   */
  markMessageHandled(params: {
    attachmentId: string;
    messageId: string;
    now?: number;
  }): boolean;

  markMessageFailed(params: { messageId: string; error?: string }): boolean;

  expireStaleLeases(now?: number): string[];

  recordAgentActivity(attachmentId: string, now?: number): void;

  reconcileOnStartup(now?: number): ReconcileResult;
}

// ====== Internal: schema init ======

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      thread_ts     TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      cwd           TEXT NOT NULL,
      machine_id    TEXT NOT NULL,
      opened_at     INTEGER NOT NULL,
      last_turn_at  INTEGER,
      status        TEXT NOT NULL DEFAULT 'active',
      meta_json     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id);
    CREATE INDEX IF NOT EXISTS idx_handoffs_status_machine ON handoffs(status, machine_id);
  `);
}

function initDurableSchema(db: Database): void {
  const { user_version: version } = db
    .query<{ user_version: number }, []>('PRAGMA user_version')
    .get() as { user_version: number };

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id                        TEXT PRIMARY KEY,
        channel_id                TEXT NOT NULL,
        thread_ts                 TEXT NOT NULL,
        session_id                TEXT,
        cwd                       TEXT NOT NULL,
        machine_id                TEXT NOT NULL,
        agent_runtime             TEXT NOT NULL DEFAULT 'claude-code',
        delivery_adapter          TEXT NOT NULL DEFAULT 'monitor',
        owner_mode                TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'active',
        last_seen_at              INTEGER,
        last_agent_activity_at    INTEGER,
        monitor_owner             TEXT,
        monitor_owner_pid         INTEGER,
        monitor_owner_started_at  INTEGER,
        monitor_owner_last_seen_at INTEGER,
        monitor_owner_expires_at  INTEGER,
        created_at                INTEGER NOT NULL,
        updated_at                INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_thread
        ON attachments(channel_id, thread_ts)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        attachment_id    TEXT NOT NULL,
        direction        TEXT NOT NULL,
        slack_ts         TEXT,
        sender_id        TEXT,
        text             TEXT NOT NULL,
        requires_response INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'persisted',
        lease_holder     TEXT,
        lease_expires_at INTEGER,
        error            TEXT,
        created_at       INTEGER NOT NULL,
        emitted_at       INTEGER,
        handled_at       INTEGER,
        FOREIGN KEY (attachment_id) REFERENCES attachments(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_attachment_status
        ON messages(attachment_id, status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_slack_ts
        ON messages(attachment_id, slack_ts)
        WHERE slack_ts IS NOT NULL;
    `);
    db.exec('PRAGMA user_version = 1');
  }

  if (version < 2) {
    // Add per-attachment stale_notice_posted_at so the heartbeat posts
    // exactly one stale notice per stale period regardless of how many
    // pending messages are still queued.
    db.exec(`
      ALTER TABLE attachments ADD COLUMN stale_notice_posted_at INTEGER;
    `);
    db.exec('PRAGMA user_version = 2');
  }

  if (version < 3) {
    // cc_pid: parent CC process PID — captured by the slash command so the
    // heartbeat can distinguish hard-dead (cc_pid gone) from soft-stale
    // (monitor unresponsive but CC alive).
    // last_soft_stale_notice_at: most recent soft-stale post timestamp, used
    // by the recurring 5-min cadence CAS.
    db.exec(`
      ALTER TABLE attachments ADD COLUMN cc_pid INTEGER;
      ALTER TABLE attachments ADD COLUMN last_soft_stale_notice_at INTEGER;
    `);
    db.exec('PRAGMA user_version = 3');
  }

  if (version < 4) {
    // error_watchdog_seen: dedup ledger for the transient-500 watchdog. One row
    // per (attachment, API-error requestId) the watchdog has already acted on,
    // so a given 500 fires the notify+nudge exactly once — even across daemon
    // restarts (this table is durable) and repeated 10-min sweeps.
    db.exec(`
      CREATE TABLE IF NOT EXISTS error_watchdog_seen (
        attachment_id TEXT NOT NULL,
        request_id    TEXT NOT NULL,
        actioned_at   INTEGER NOT NULL,
        PRIMARY KEY (attachment_id, request_id)
      );
    `);
    db.exec('PRAGMA user_version = 4');
  }
}

// ====== Internal: build Registry methods from an open Database ======

function buildRegistryMethods(db: Database): Registry {
  return {
    insertHandoff(row: InsertHandoff): void {
      db.query(
        `INSERT INTO handoffs (thread_ts, channel_id, session_id, cwd, machine_id, opened_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      ).run(
        row.thread_ts,
        row.channel_id,
        row.session_id,
        row.cwd,
        row.machine_id,
        row.opened_at,
      );
    },

    findByThreadTs(threadTs: string): HandoffRow | null {
      return (
        (db
          .query<HandoffRow, [string]>(
            'SELECT * FROM handoffs WHERE thread_ts = ?',
          )
          .get(threadTs) as HandoffRow | null) ?? null
      );
    },

    findActiveBySessionId(sessionId: string): HandoffRow | null {
      return (
        (db
          .query<HandoffRow, [string]>(
            "SELECT * FROM handoffs WHERE session_id = ? AND status = 'active' ORDER BY opened_at DESC LIMIT 1",
          )
          .get(sessionId) as HandoffRow | null) ?? null
      );
    },

    markStatus(threadTs: string, status: HandoffStatus): void {
      db.query('UPDATE handoffs SET status = ? WHERE thread_ts = ?').run(
        status,
        threadTs,
      );
    },

    markLastTurn(threadTs: string, ts: number = Date.now()): void {
      db.query('UPDATE handoffs SET last_turn_at = ? WHERE thread_ts = ?').run(
        ts,
        threadTs,
      );
    },

    countByStatus(status: HandoffStatus = 'active'): number {
      const row = db
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) as count FROM handoffs WHERE status = ?',
        )
        .get(status) as { count: number };
      return row.count;
    },
  };
}

// ====== createRegistry (unchanged public API) ======

export function createRegistry(opts: { dbPath: string }): Registry {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  initSchema(db);
  return buildRegistryMethods(db);
}

// ====== createDurableRegistry ======

export function createDurableRegistry(opts: {
  dbPath: string;
}): DurableRegistry {
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  initSchema(db);
  initDurableSchema(db);

  const base = buildRegistryMethods(db);

  // ---- Internal helpers (capture db) ----

  function getAttachment(id: string): AttachmentRow | null {
    return (
      (db
        .query<AttachmentRow, [string]>(
          'SELECT * FROM attachments WHERE id = ?',
        )
        .get(id) as AttachmentRow | null) ?? null
    );
  }

  function doExpireStaleLeases(now: number): string[] {
    const expired = db
      .query<{ id: string }, [number]>(
        "SELECT id FROM messages WHERE status = 'leased' AND lease_expires_at <= ?",
      )
      .all(now);
    if (expired.length === 0) return [];
    db.query(
      "UPDATE messages SET status = 'persisted', lease_holder = NULL, lease_expires_at = NULL WHERE status = 'leased' AND lease_expires_at <= ?",
    ).run(now);
    return expired.map((r) => r.id);
  }

  // ---- DurableRegistry implementation ----

  return {
    ...base,

    createOrReuseAttachment(params: CreateAttachmentParams): AttachmentRow {
      return db.transaction(() => {
        const existing = db
          .query<AttachmentRow, [string, string]>(
            "SELECT * FROM attachments WHERE channel_id = ? AND thread_ts = ? AND status = 'active'",
          )
          .get(params.channelId, params.threadTs) as AttachmentRow | null;
        if (existing) {
          // Refresh cc_pid on re-attach so a new CC session inheriting the
          // same thread is tracked correctly (old PID may no longer be alive).
          if (params.ccPid != null && existing.cc_pid !== params.ccPid) {
            const now = params.now ?? Date.now();
            db.query(
              'UPDATE attachments SET cc_pid = ?, updated_at = ? WHERE id = ?',
            ).run(params.ccPid, now, existing.id);
            return getAttachment(existing.id) as AttachmentRow;
          }
          return existing;
        }

        const id = crypto.randomUUID();
        const now = params.now ?? Date.now();
        db.query(
          `INSERT INTO attachments
             (id, channel_id, thread_ts, session_id, cwd, machine_id,
              agent_runtime, delivery_adapter, owner_mode, status,
              cc_pid, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(
          id,
          params.channelId,
          params.threadTs,
          params.sessionId ?? null,
          params.cwd,
          params.machineId,
          params.agentRuntime ?? 'claude-code',
          params.deliveryAdapter ?? 'monitor',
          params.ownerMode,
          params.ccPid ?? null,
          now,
          now,
        );
        return getAttachment(id) as AttachmentRow;
      })();
    },

    getAttachment(id: string): AttachmentRow | null {
      return getAttachment(id);
    },

    listActiveAttachments(): AttachmentRow[] {
      return db
        .query<AttachmentRow, []>(
          "SELECT * FROM attachments WHERE status = 'active'",
        )
        .all();
    },

    tryRecordWatchdogError(
      attachmentId: string,
      requestId: string,
      now: number = Date.now(),
    ): boolean {
      const result = db
        .query(
          `INSERT OR IGNORE INTO error_watchdog_seen
             (attachment_id, request_id, actioned_at)
           VALUES (?, ?, ?)`,
        )
        .run(attachmentId, requestId, now);
      return (result as { changes: number }).changes > 0;
    },

    findActiveAttachmentByChannelThread(
      channelId: string,
      threadTs: string,
    ): AttachmentRow | null {
      return (
        (db
          .query<AttachmentRow, [string, string]>(
            "SELECT * FROM attachments WHERE channel_id = ? AND thread_ts = ? AND status = 'active' LIMIT 1",
          )
          .get(channelId, threadTs) as AttachmentRow | null) ?? null
      );
    },

    findRoutableAttachmentByChannelThread(
      channelId: string,
      threadTs: string,
    ): AttachmentRow | null {
      // Includes stale so routeThreadReply can persist + post stale notice
      // for stale attachments instead of silently dropping the reply.
      // Excludes ended/errored which are terminal and not eligible.
      return (
        (db
          .query<AttachmentRow, [string, string]>(
            "SELECT * FROM attachments WHERE channel_id = ? AND thread_ts = ? AND status IN ('active','stale') ORDER BY status='active' DESC LIMIT 1",
          )
          .get(channelId, threadTs) as AttachmentRow | null) ?? null
      );
    },

    findActiveAttachmentBySessionId(sessionId: string): AttachmentRow | null {
      return (
        (db
          .query<AttachmentRow, [string]>(
            "SELECT * FROM attachments WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
          )
          .get(sessionId) as AttachmentRow | null) ?? null
      );
    },

    findRoutableAttachmentBySessionId(sessionId: string): AttachmentRow | null {
      // Active OR stale — matches `findRoutableAttachmentByChannelThread`.
      // Stale attachments still receive Slack inbound traffic (the daemon
      // posts a stale notice rather than dropping replies), so outbound
      // posts from `/post` MUST also route into them. Otherwise an attached
      // session whose monitor briefly stopped checking in (stale) falls
      // back to creating a new legacy handoff thread on every post.
      // Prefer active over stale when both exist (ORDER BY status='active').
      return (
        (db
          .query<AttachmentRow, [string]>(
            "SELECT * FROM attachments WHERE session_id = ? AND status IN ('active','stale') ORDER BY status = 'active' DESC, created_at DESC LIMIT 1",
          )
          .get(sessionId) as AttachmentRow | null) ?? null
      );
    },

    sweepStaleAttachments(now: number = Date.now()): string[] {
      const candidates = db
        .query<{ id: string }, [number]>(
          "SELECT id FROM attachments WHERE status = 'active' AND monitor_owner IS NOT NULL AND monitor_owner_expires_at <= ?",
        )
        .all(now);
      if (candidates.length === 0) return [];
      db.query(
        "UPDATE attachments SET status = 'stale', updated_at = ? WHERE status = 'active' AND monitor_owner IS NOT NULL AND monitor_owner_expires_at <= ?",
      ).run(now, now);
      return candidates.map((r) => r.id);
    },

    claimMonitorOwnership(params): ClaimMonitorResult {
      const {
        attachmentId,
        ownerToken,
        pid,
        startedAt,
        ttlMs = STALE_THRESHOLD_MS,
        now = Date.now(),
      } = params;

      return db.transaction((): ClaimMonitorResult => {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return { ok: false, reason: 'not_found' };

        // Strict claim: only succeeds when no owner is recorded. Expired-owner
        // replacement MUST go through takeOverStaleMonitor so its in-flight
        // `leased` messages get reclaimed back to `persisted`. If we silently
        // overwrote an expired owner here, those messages would stay leased
        // until the next expireStaleLeases sweep — and a fresh monitor that
        // immediately long-polls would see nothing to deliver. Phase 2's HTTP
        // handler is responsible for routing: NULL → claim, expired → takeover.
        if (attachment.monitor_owner !== null) {
          const expired =
            attachment.monitor_owner_expires_at !== null &&
            attachment.monitor_owner_expires_at <= now;
          return {
            ok: false,
            reason: expired ? 'stale_existing' : 'already_owned',
            existingToken: attachment.monitor_owner,
            existingPid: attachment.monitor_owner_pid,
            existingStartedAt: attachment.monitor_owner_started_at,
          };
        }

        const expiresAt = now + ttlMs;
        db.query(
          `UPDATE attachments
           SET monitor_owner = ?, monitor_owner_pid = ?,
               monitor_owner_started_at = ?, monitor_owner_last_seen_at = ?,
               monitor_owner_expires_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(ownerToken, pid, startedAt, now, expiresAt, now, attachmentId);

        return { ok: true, ownerToken };
      })();
    },

    monitorCheckin(params): boolean {
      const {
        attachmentId,
        ownerToken,
        ttlMs = STALE_THRESHOLD_MS,
        now = Date.now(),
      } = params;

      // Recovery: a successful check-in for a stale attachment restores it
      // to active. The design says recovery makes the attachment active again
      // so subsequent Slack messages stop showing the stale notice.
      const result = db
        .query(
          `UPDATE attachments
           SET monitor_owner_last_seen_at = ?, monitor_owner_expires_at = ?,
               last_agent_activity_at = ?, status = 'active', updated_at = ?
           WHERE id = ? AND monitor_owner = ?`,
        )
        .run(now, now + ttlMs, now, now, attachmentId, ownerToken);

      return (result as { changes: number }).changes > 0;
    },

    replaceMonitorOwner(params): ReplaceMonitorOwnerResult {
      const {
        attachmentId,
        ownerToken,
        pid,
        startedAt,
        ttlMs = STALE_THRESHOLD_MS,
        now = Date.now(),
        reclaimLeases = false,
      } = params;

      return db.transaction((): ReplaceMonitorOwnerResult => {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return { ok: false, reason: 'not_found' };
        if (attachment.monitor_owner !== ownerToken) {
          return { ok: false, reason: 'not_owner' };
        }

        db.query(
          `UPDATE attachments
           SET monitor_owner_pid = ?, monitor_owner_started_at = ?,
               monitor_owner_last_seen_at = ?, monitor_owner_expires_at = ?,
               last_agent_activity_at = ?, status = 'active',
               stale_notice_posted_at = NULL,
               last_soft_stale_notice_at = NULL, updated_at = ?
           WHERE id = ? AND monitor_owner = ?`,
        ).run(
          pid,
          startedAt,
          now,
          now + ttlMs,
          now,
          now,
          attachmentId,
          ownerToken,
        );

        const leased = reclaimLeases
          ? db
              .query<{ id: string }, [string, string]>(
                "SELECT id FROM messages WHERE attachment_id = ? AND status = 'leased' AND lease_holder = ?",
              )
              .all(attachmentId, ownerToken)
          : [];
        const reclaimedMessageIds = leased.map((r) => r.id);

        if (reclaimedMessageIds.length > 0) {
          db.query(
            "UPDATE messages SET status = 'persisted', lease_holder = NULL, lease_expires_at = NULL WHERE attachment_id = ? AND status = 'leased' AND lease_holder = ?",
          ).run(attachmentId, ownerToken);
        }

        return { ok: true, ownerToken, reclaimedMessageIds };
      })();
    },

    markAttachmentStale(attachmentId: string, now: number = Date.now()): void {
      db.query(
        "UPDATE attachments SET status = 'stale', updated_at = ? WHERE id = ?",
      ).run(now, attachmentId);
    },

    setAttachmentSessionId(attachmentId: string, sessionId: string): void {
      db.query(
        'UPDATE attachments SET session_id = ?, updated_at = ? WHERE id = ?',
      ).run(sessionId, Date.now(), attachmentId);
    },

    markAttachmentEnded(attachmentId: string): void {
      db.query(
        "UPDATE attachments SET status = 'ended', updated_at = ? WHERE id = ?",
      ).run(Date.now(), attachmentId);
    },

    markAttachmentErrored(attachmentId: string): void {
      db.query(
        "UPDATE attachments SET status = 'errored', updated_at = ? WHERE id = ?",
      ).run(Date.now(), attachmentId);
    },

    tryMarkStaleNoticePosted(
      attachmentId: string,
      now: number = Date.now(),
    ): boolean {
      // Atomic CAS: only the first caller that observes NULL wins the right
      // to post the hard-dead notice. SQLite single-statement UPDATE counts
      // as atomic under WAL.
      const result = db
        .query(
          'UPDATE attachments SET stale_notice_posted_at = ? WHERE id = ? AND stale_notice_posted_at IS NULL',
        )
        .run(now, attachmentId);
      return (result as { changes: number }).changes > 0;
    },

    tryMarkSoftStaleNotice(
      attachmentId: string,
      intervalMs: number,
      now: number = Date.now(),
    ): boolean {
      // Recurring CAS: succeed if last_soft_stale_notice_at is NULL or older
      // than intervalMs. Single UPDATE is atomic under SQLite WAL.
      const result = db
        .query(
          `UPDATE attachments
             SET last_soft_stale_notice_at = ?
           WHERE id = ?
             AND (last_soft_stale_notice_at IS NULL
                  OR last_soft_stale_notice_at <= ?)`,
        )
        .run(now, attachmentId, now - intervalMs);
      return (result as { changes: number }).changes > 0;
    },

    clearStaleNoticePosted(attachmentId: string): void {
      db.query(
        `UPDATE attachments
           SET stale_notice_posted_at = NULL,
               last_soft_stale_notice_at = NULL
         WHERE id = ?`,
      ).run(attachmentId);
    },

    takeOverStaleMonitor(params): TakeOverResult {
      const {
        attachmentId,
        newOwnerToken,
        newPid,
        newStartedAt,
        ttlMs = STALE_THRESHOLD_MS,
        now = Date.now(),
      } = params;

      return db.transaction((): TakeOverResult => {
        const attachment = getAttachment(attachmentId);
        if (!attachment) return { ok: false, reason: 'not_found' };

        // Only allowed if current owner is expired (or absent)
        const ownerIsHealthy =
          attachment.monitor_owner !== null &&
          attachment.monitor_owner_expires_at !== null &&
          attachment.monitor_owner_expires_at > now;

        if (ownerIsHealthy) return { ok: false, reason: 'not_stale' };

        // Recovery: stale → active. Takeover restores liveness.
        const expiresAt = now + ttlMs;
        db.query(
          `UPDATE attachments
           SET monitor_owner = ?, monitor_owner_pid = ?,
               monitor_owner_started_at = ?, monitor_owner_last_seen_at = ?,
               monitor_owner_expires_at = ?, status = 'active',
               stale_notice_posted_at = NULL,
               last_soft_stale_notice_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(
          newOwnerToken,
          newPid,
          newStartedAt,
          now,
          expiresAt,
          now,
          attachmentId,
        );

        // Return any in-flight leased messages to persisted
        const leased = db
          .query<{ id: string }, [string]>(
            "SELECT id FROM messages WHERE attachment_id = ? AND status = 'leased'",
          )
          .all(attachmentId);

        const reclaimedMessageIds = leased.map((r) => r.id);

        if (reclaimedMessageIds.length > 0) {
          db.query(
            "UPDATE messages SET status = 'persisted', lease_holder = NULL, lease_expires_at = NULL WHERE attachment_id = ? AND status = 'leased'",
          ).run(attachmentId);
        }

        return { ok: true, ownerToken: newOwnerToken, reclaimedMessageIds };
      })();
    },

    insertInboundMessage(params: InsertMessageParams): MessageRow {
      const id = crypto.randomUUID();
      const now = params.now ?? Date.now();

      // UNIQUE constraint on (attachment_id, slack_ts) WHERE slack_ts IS NOT NULL
      // surfaces as a thrown error for duplicate slack_ts — no procedural pre-check.
      db.query(
        `INSERT INTO messages
           (id, attachment_id, direction, slack_ts, sender_id, text,
            requires_response, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'persisted', ?)`,
      ).run(
        id,
        params.attachmentId,
        params.direction,
        params.slackTs ?? null,
        params.senderId ?? null,
        params.text,
        params.requiresResponse ? 1 : 0,
        now,
      );

      return db
        .query<MessageRow, [string]>('SELECT * FROM messages WHERE id = ?')
        .get(id) as MessageRow;
    },

    getMessageById(id: string): MessageRow | null {
      return (
        (db
          .query<MessageRow, [string]>('SELECT * FROM messages WHERE id = ?')
          .get(id) as MessageRow | null) ?? null
      );
    },

    leaseNextMessages(params): LeasedMessageRow[] {
      const {
        attachmentId,
        ownerToken,
        leaseTtlMs = LEASE_TTL_MS,
        limit = 1,
        now = Date.now(),
      } = params;
      const expiresAt = now + leaseTtlMs;

      return db.transaction((): LeasedMessageRow[] => {
        const candidates = db
          .query<{ id: string }, [string, number]>(
            "SELECT id FROM messages WHERE attachment_id = ? AND status = 'persisted' ORDER BY created_at ASC LIMIT ?",
          )
          .all(attachmentId, limit);

        if (candidates.length === 0) return [];

        for (const { id } of candidates) {
          db.query(
            "UPDATE messages SET status = 'leased', lease_holder = ?, lease_expires_at = ? WHERE id = ?",
          ).run(ownerToken, expiresAt, id);
        }

        const ids = candidates.map((c) => c.id);
        const placeholders = ids.map(() => '?').join(',');
        return db
          .query<LeasedMessageRow, string[]>(
            `SELECT * FROM messages WHERE id IN (${placeholders})`,
          )
          .all(...ids) as LeasedMessageRow[];
      })();
    },

    markMessageEmitted(params): boolean {
      const { messageId, ownerToken, now = Date.now() } = params;
      const result = db
        .query(
          "UPDATE messages SET status = 'emitted', emitted_at = ? WHERE id = ? AND status = 'leased' AND lease_holder = ?",
        )
        .run(now, messageId, ownerToken);
      return (result as { changes: number }).changes > 0;
    },

    markMessageHandled(params): boolean {
      const { attachmentId, messageId, now = Date.now() } = params;
      const result = db
        .query(
          "UPDATE messages SET status = 'handled', handled_at = ? WHERE id = ? AND attachment_id = ? AND status IN ('persisted', 'leased', 'emitted')",
        )
        .run(now, messageId, attachmentId);
      return (result as { changes: number }).changes > 0;
    },

    markMessageFailed(params): boolean {
      const { messageId, error } = params;
      const result = db
        .query(
          "UPDATE messages SET status = 'failed', error = ? WHERE id = ? AND status NOT IN ('handled', 'failed')",
        )
        .run(error ?? null, messageId);
      return (result as { changes: number }).changes > 0;
    },

    expireStaleLeases(now: number = Date.now()): string[] {
      return doExpireStaleLeases(now);
    },

    recordAgentActivity(attachmentId: string, now: number = Date.now()): void {
      db.query(
        'UPDATE attachments SET last_agent_activity_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, attachmentId);
    },

    reconcileOnStartup(now: number = Date.now()): ReconcileResult {
      return db.transaction((): ReconcileResult => {
        // 1. Clear expired monitor ownership
        const expiredOwners = db
          .query<{ id: string }, [number]>(
            'SELECT id FROM attachments WHERE monitor_owner IS NOT NULL AND monitor_owner_expires_at <= ?',
          )
          .all(now);

        if (expiredOwners.length > 0) {
          db.query(
            'UPDATE attachments SET monitor_owner = NULL, monitor_owner_pid = NULL, monitor_owner_started_at = NULL, monitor_owner_last_seen_at = NULL, monitor_owner_expires_at = NULL, updated_at = ? WHERE monitor_owner IS NOT NULL AND monitor_owner_expires_at <= ?',
          ).run(now, now);
        }

        // 2. Reclaim leased messages whose TTL has expired
        const reclaimedMessageIds = doExpireStaleLeases(now);

        return {
          expiredMonitorOwners: expiredOwners.map((r) => r.id),
          reclaimedMessageIds,
        };
      })();
    },
  };
}

// ====== Production singleton (legacy API) ======

let _singleton: Registry | null = null;

function getSingleton(): Registry {
  if (!_singleton) _singleton = createRegistry({ dbPath: DEFAULT_DB_PATH });
  return _singleton;
}

export function insertHandoff(row: InsertHandoff): void {
  getSingleton().insertHandoff(row);
}

export function findByThreadTs(threadTs: string): HandoffRow | null {
  return getSingleton().findByThreadTs(threadTs);
}

export function findActiveBySessionId(sessionId: string): HandoffRow | null {
  return getSingleton().findActiveBySessionId(sessionId);
}

export function markStatus(threadTs: string, status: HandoffStatus): void {
  getSingleton().markStatus(threadTs, status);
}

export function markLastTurn(threadTs: string, ts: number = Date.now()): void {
  getSingleton().markLastTurn(threadTs, ts);
}

export function countByStatus(status: HandoffStatus = 'active'): number {
  return getSingleton().countByStatus(status);
}

