/**
 * Pending-response heartbeat manager.
 *
 * For each inbound Slack message that requires_response, a heartbeat loop:
 *   - NEVER posts _thinking..._ on its own. The 📥 reaction already confirms
 *     the daemon received the message; an additional thread-level "thinking"
 *     ack is noise. The only _thinking..._ in the system is the one-shot
 *     placeholder posted by a daemon-owned headless turn. That path is owned
 *     by headless-turn.ts, not this manager.
 *   - Posts "still working... Xm since your message, last agent activity Ym ago"
 *     every postIntervalMs once the message is emitted or the monitor is
 *     already healthy at persist time. This is the slow-work liveness signal.
 *     Suppressed if any agent activity (reply/handled/status/heartbeat) hit
 *     this attachment within postIntervalMs — the recent post is already the
 *     liveness signal. Each heartbeat post calls recordAgentActivity, so
 *     parallel pending messages collapse to at most one _still working..._
 *     per postIntervalMs across the thread rather than one per message.
 *   - PID-fast-stale: each tick probes monitor_owner_pid liveness. When the
 *     OS reports the owner PID is gone we immediately mark the attachment
 *     stale rather than waiting on the time-based monitor_owner_expires_at.
 *     Detection latency is bounded by checkIntervalMs (default 30s) instead
 *     of the daemon's 60s staleness threshold + scheduler lag.
 *   - Stops on: reply/handled (external stop or polled status), stale (one
 *     consolidated notice via tryMarkStaleNoticePosted then suspended),
 *     ended/errored (final post), 60-min cap.
 *   - Detects monitor recovery silently — the next "still working" post (if it
 *     ever fires) signals liveness; no resumption banner is posted.
 */

import type { AttachmentRow, DurableRegistry } from '../registry';
import type { SlackPoster } from './types';

// Defaults (overridable in tests)
const DEFAULT_CHECK_INTERVAL_MS = 30_000;
// "still working" cadence: first post after 5 min, then every 5 min after that.
// Tuned so quick replies (≤5 min) stay silent — 📥 is the only thread signal.
// Exported so headless-turn.ts can match the cadence.
export const DEFAULT_POST_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_DURATION_MS = 60 * 60_000;

type HeartbeatPhase = 'queued' | 'thinking' | 'suspended' | 'done';

interface HeartbeatEntry {
  messageId: string;
  attachmentId: string;
  channel: string;
  threadTs: string;
  createdAt: number;
  phase: HeartbeatPhase;
  lastPostTime: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HeartbeatStartParams {
  messageId: string;
  attachmentId: string;
  channel: string;
  threadTs: string;
  /** Unix ms from message.created_at — used for elapsed time in heartbeat copy. */
  createdAt: number;
}

export interface HeartbeatManager {
  /** Start a heartbeat for a newly persisted inbound message. No-op if already started. */
  start(params: HeartbeatStartParams): void;
  /** Immediately stop the heartbeat for a message (e.g. reply or handled route). */
  stop(messageId: string): void;
  /** Stop all active heartbeats (e.g. daemon shutdown). */
  stopAll(): void;
}

export interface HeartbeatManagerConfig {
  registry: DurableRegistry;
  poster: SlackPoster;
  /** How often to poll registry state (ms). Default: 30_000. */
  checkIntervalMs?: number;
  /** How often to post repeating heartbeat text (ms). Default: 300_000. */
  postIntervalMs?: number;
  /** Hard cap for heartbeat duration (ms). Default: 3_600_000 (60 min). */
  maxDurationMs?: number;
  /**
   * Override OS-level PID liveness probe. Defaults to `process.kill(pid, 0)`.
   * Injected for tests so we don't depend on real OS state. EPERM (signal
   * blocked by another user) still counts as alive — the process exists.
   */
  isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function createHeartbeatManager(
  config: HeartbeatManagerConfig,
): HeartbeatManager {
  const {
    registry,
    poster,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    postIntervalMs = DEFAULT_POST_INTERVAL_MS,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    isPidAlive = defaultIsPidAlive,
  } = config;

  const entries = new Map<string, HeartbeatEntry>();

  function formatMinutes(ms: number): string {
    return `${Math.round(ms / 60_000)}m`;
  }

  function isMonitorHealthy(attachment: AttachmentRow, now: number): boolean {
    return (
      attachment.monitor_owner_expires_at !== null &&
      attachment.monitor_owner_expires_at > now
    );
  }

  function scheduleCheck(entry: HeartbeatEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      tick(entry).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[agent-comms] heartbeat tick error for message=${entry.messageId}: ${msg}`,
        );
      });
    }, checkIntervalMs);
  }

  async function postSafe(entry: HeartbeatEntry, text: string): Promise<void> {
    await poster
      .postThreadMessage({
        channel: entry.channel,
        threadTs: entry.threadTs,
        text,
      })
      .catch((err: unknown) => {
        console.error(
          `[agent-comms] heartbeat post failed for message=${entry.messageId}: ${(err as Error).message ?? String(err)}`,
        );
      });
  }

  async function tick(entry: HeartbeatEntry): Promise<void> {
    if (entry.phase === 'done') return;

    const now = Date.now();
    const elapsed = now - entry.createdAt;

    const message = registry.getMessageById(entry.messageId);
    let attachment = registry.getAttachment(entry.attachmentId);

    if (!message || !attachment) {
      entry.phase = 'done';
      entries.delete(entry.messageId);
      return;
    }

    // ── Stale classification ──────────────────────────────────────────────────
    //
    // Two distinct conditions, two distinct UX:
    //   - hard-dead: cc_pid is gone → CC session is definitively terminated,
    //     no recovery possible until the user re-attaches. Post a one-shot
    //     "session terminated" notice immediately.
    //   - soft-stale: monitor_owner_pid is gone but cc_pid is still alive
    //     (rare: monitor crashed, CC didn't). Hold the notice for 5 minutes
    //     and only post if the condition persists. Repeat at 5-min cadence.
    //
    // Legacy attachments (cc_pid == null) created before this column was
    // plumbed fall back to soft-stale semantics — we can't prove CC death.
    const monitorPid = attachment.monitor_owner_pid;
    const monitorDead = monitorPid !== null && !isPidAlive(monitorPid);
    const ccDead = attachment.cc_pid !== null && !isPidAlive(attachment.cc_pid);
    const hardDead = ccDead;

    if (attachment.status === 'active' && (monitorDead || ccDead)) {
      // Flip to stale so monitor-takeover/reclaim paths fire correctly later.
      registry.markAttachmentStale(entry.attachmentId, now);
      console.log(
        `[agent-comms] PID probe: attachment=${entry.attachmentId} cc_pid=${attachment.cc_pid ?? 'null'} monitor_pid=${monitorPid ?? 'null'} ccDead=${ccDead} monitorDead=${monitorDead} → stale`,
      );
      const refreshed = registry.getAttachment(entry.attachmentId);
      if (refreshed) attachment = refreshed;
    }

    // ── Termination checks (priority order) ─────────────────────────────────

    if (message.status === 'handled') {
      entry.phase = 'done';
      entries.delete(entry.messageId);
      return;
    }

    if (message.status === 'failed') {
      await postSafe(entry, '⚠️ _message delivery failed — check daemon logs_');
      entry.phase = 'done';
      entries.delete(entry.messageId);
      return;
    }

    if (attachment.status === 'ended') {
      await postSafe(
        entry,
        '_the attached session has ended — no response will be sent_',
      );
      entry.phase = 'done';
      entries.delete(entry.messageId);
      return;
    }

    if (attachment.status === 'errored') {
      await postSafe(
        entry,
        '_the attached session encountered an error — no response will be sent_',
      );
      entry.phase = 'done';
      entries.delete(entry.messageId);
      return;
    }

    if (elapsed >= maxDurationMs) {
      await postSafe(
        entry,
        '_pending response timeout — attachment looks healthy but Claude has not acknowledged — check the session_',
      );
      entry.phase = 'done';
      entries.delete(entry.messageId);
      return;
    }

    // ── Stale handling ────────────────────────────────────────────────────────

    if (attachment.status === 'stale') {
      if (hardDead) {
        // CC PID confirmed dead → one-shot session-terminated notice.
        // CAS guarantees exactly one post across all pending heartbeats for
        // this attachment; everyone else suspends silently.
        const shouldPost = registry.tryMarkStaleNoticePosted(
          entry.attachmentId,
          now,
        );
        if (shouldPost) {
          await postSafe(
            entry,
            '_attached Claude Code session appears terminated — your messages are queued and will deliver when you start a new session and run `/slack-attach-session`_',
          );
          console.log(
            `[agent-comms] hard-dead notice posted for attachment=${entry.attachmentId} (via message=${entry.messageId}, cc_pid=${attachment.cc_pid} gone)`,
          );
        } else {
          console.log(
            `[agent-comms] heartbeat suspended for message=${entry.messageId} (hard-dead; notice already posted)`,
          );
        }
        entry.phase = 'suspended';
        scheduleCheck(entry);
        return;
      }

      // Soft-stale: monitor unresponsive but CC alive (or cc_pid unknown).
      // Wait postIntervalMs (default 5 min) before posting; repost at
      // postIntervalMs cadence while the condition persists.
      // Fallback to attachment.updated_at when monitor never checked in —
      // updated_at is bumped by markAttachmentStale, so the difference is
      // "how long has this been stale" which is what we actually want.
      const staleStart =
        attachment.monitor_owner_last_seen_at ?? attachment.updated_at;
      const elapsedSinceLastSeen = now - staleStart;
      if (elapsedSinceLastSeen >= postIntervalMs) {
        const shouldPost = registry.tryMarkSoftStaleNotice(
          entry.attachmentId,
          postIntervalMs,
          now,
        );
        if (shouldPost) {
          const minutes = Math.max(
            1,
            Math.round(elapsedSinceLastSeen / 60_000),
          );
          await postSafe(
            entry,
            `_queued — Claude Code monitor has not checked in for ${minutes}m. The CC session may still be alive; messages will deliver when the monitor reconnects or you re-attach via \`/slack-attach-session\`._`,
          );
          console.log(
            `[agent-comms] soft-stale notice posted for attachment=${entry.attachmentId} (via message=${entry.messageId}, ${minutes}m since last_seen)`,
          );
        } else {
          console.log(
            `[agent-comms] heartbeat suspended for message=${entry.messageId} (soft-stale; another tick recently posted)`,
          );
        }
      } else {
        // Too early — hold quiet until the 5-min threshold.
        console.log(
          `[agent-comms] heartbeat soft-stale holding for message=${entry.messageId} (only ${Math.round(elapsedSinceLastSeen / 1000)}s since last_seen, < postIntervalMs)`,
        );
      }
      entry.phase = 'suspended';
      scheduleCheck(entry);
      return;
    }

    // ── Recovery from stale (attachment back to active while suspended) ───────
    //
    // Transition silently: 📥 already shows messages were received; the next
    // "_still working..._" post (if any) will signal liveness when it fires.
    if (entry.phase === 'suspended' && attachment.status === 'active') {
      entry.phase = 'thinking';
      entry.lastPostTime = now;
      console.log(
        `[agent-comms] heartbeat resumed for message=${entry.messageId} (monitor recovered)`,
      );
      scheduleCheck(entry);
      return;
    }

    // ── Active path ───────────────────────────────────────────────────────────

    const monitorHealthy = isMonitorHealthy(attachment, now);
    const emitted = message.status === 'emitted';

    if (entry.phase === 'queued' && (emitted || monitorHealthy)) {
      // 📥 reaction is the only "received" signal in-thread. Silent transition;
      // first user-visible post is the _still working..._ timer (5 min).
      entry.phase = 'thinking';
      entry.lastPostTime = now;
    } else if (
      entry.phase === 'thinking' &&
      now - entry.lastPostTime >= postIntervalMs
    ) {
      // Suppress when the agent has posted anything (reply / handled / status /
      // heartbeat from a parallel pending message) within postIntervalMs.
      // The recent post is itself the liveness signal — an extra _still
      // working..._ on top is just noise. This also naturally serializes
      // parallel heartbeats: whichever fires first records activity, the
      // others see it on their next tick and stay quiet. Net effect: at most
      // one _still working..._ per postIntervalMs across the whole thread.
      //
      // Re-read the attachment HERE rather than reusing the snapshot from the
      // top of tick() — by the time we get this deep, a parallel heartbeat
      // may have recorded activity since our initial read. recordAgentActivity
      // is then called BEFORE postSafe so the activity write happens before
      // the await yields the event loop, closing the TOCTOU window for any
      // heartbeat that re-reads while we're awaiting Slack.
      const freshAttachment =
        registry.getAttachment(entry.attachmentId) ?? attachment;
      const lastActivityAt = freshAttachment.last_agent_activity_at;
      const agentRecentlyActive =
        lastActivityAt !== null && now - lastActivityAt < postIntervalMs;
      if (!agentRecentlyActive) {
        const sinceMessage = formatMinutes(elapsed);
        const lastActivity = lastActivityAt
          ? formatMinutes(now - lastActivityAt)
          : null;
        const text = lastActivity
          ? `_still working... ${sinceMessage} since your message, last agent activity ${lastActivity} ago_`
          : `_still working... ${sinceMessage} since your message_`;
        registry.recordAgentActivity(entry.attachmentId, now);
        await postSafe(entry, text);
      }
      entry.lastPostTime = now;
    }

    scheduleCheck(entry);
  }

  return {
    start(params) {
      if (entries.has(params.messageId)) return;

      const entry: HeartbeatEntry = {
        ...params,
        phase: 'queued',
        lastPostTime: 0,
        timer: null,
      };
      entries.set(params.messageId, entry);

      // First check fires immediately (setTimeout(0) to avoid synchronous posting
      // inside the Slack event handler). If the monitor is already healthy, this
      // posts _thinking..._ before the next check interval.
      entry.timer = setTimeout(() => {
        tick(entry).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[agent-comms] heartbeat initial tick error for message=${entry.messageId}: ${msg}`,
          );
        });
      }, 0);
    },

    stop(messageId) {
      const entry = entries.get(messageId);
      if (!entry) return;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.phase = 'done';
      entries.delete(messageId);
    },

    stopAll() {
      for (const entry of entries.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.phase = 'done';
      }
      entries.clear();
    },
  };
}

