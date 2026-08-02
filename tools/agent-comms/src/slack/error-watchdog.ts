/**
 * Transient-500 watchdog.
 *
 * A standing periodic sweep (default every 10 min) over live, terminal-attached
 * sessions. For each, it scans the CC session transcript for the most recent
 * API-error record (a 500 that ended a turn) and — exactly once per distinct
 * requestId — posts a heads-up to the attachment's Slack thread AND injects a
 * "continue if blocked/frozen" nudge into the session via the same inbound path
 * a human Slack reply takes (the session's `agent-comms monitor` leases and
 * delivers it, waking an idle/bricked session).
 *
 * Why this exists: when the model inference API returns a 500 mid-turn, the CC
 * harness surfaces it as a synthetic assistant message and ENDS the turn — it
 * does not auto-resume. A terminal-attached AFK session then sits idle until a
 * human notices and SSHes in. This closes that gap automatically.
 *
 * Gating — ALL must hold to act on an attachment:
 *   - status === 'active'                 (not ended/errored/stale)
 *   - owner_mode === 'terminal-attached'  (monitor-delivered; daemon-spawned
 *                                           turns are driven per-turn via
 *                                           `claude -p --resume` and have no
 *                                           long-lived session to nudge)
 *   - session_id present                  (needed to locate the transcript)
 *   - cc_pid alive                         (the session process is live and
 *                                           resumable — a 500 idles the turn
 *                                           but does not kill the process)
 *
 * Dedup: `registry.tryRecordWatchdogError(attachmentId, requestId)` is the
 * authoritative one-shot gate, durable across daemon restarts and sweeps. We
 * mark-then-act, so a crash mid-action cannot duplicate the alert on the next
 * sweep (at-most-once — "only once per error" is the hard requirement, and a
 * missed nudge is recoverable: a new 500 has a new requestId and re-fires).
 *
 * We look at only the LATEST 500 in the transcript (not every historical one),
 * so the first sweep of a long-lived session can't dump a burst of nudges for
 * 500s it already powered past; older requestIds simply stay unrecorded and
 * never become "latest" again.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentRow, DurableRegistry } from '../registry';
import type { SlackPoster } from './types';

const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000; // 10 min

/**
 * The continue nudge injected into a (possibly) frozen session. Worded as a
 * conditional — "continue IF blocked/frozen" — so it is a harmless no-op when
 * the session is actually fine (a tolerable false alarm), and an un-bricking
 * prompt when it really did freeze on the 500.
 */
export const CONTINUE_NUDGE_TEXT =
  'continue if blocked/frozen - a 500 error was identified in the transcript record which can sometimes freeze an active session';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM'; // exists but owned by another user
  }
}

function defaultReadTranscript(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Build the transcript path for a session from its cwd + session id. CC stores
 * sessions at ~/.claude/projects/{cwd-with-every-slash-as-dash}/{id}.jsonl.
 * We construct the path directly from the attachment's stored session_id rather
 * than picking the newest jsonl for the cwd — two sessions can share one cwd
 * (e.g. a monorepo), so "newest" would be ambiguous.
 */
function transcriptPathFor(
  projectsDir: string,
  cwd: string,
  sessionId: string,
): string {
  return join(projectsDir, cwd.replaceAll('/', '-'), `${sessionId}.jsonl`);
}

export interface ErrorMarker {
  requestId: string;
  apiErrorStatus: number;
}

/**
 * Scan a transcript for the MOST RECENT 500 API-error marker, or null if none.
 * A marker is a record with `isApiErrorMessage === true` and
 * `apiErrorStatus === 500`; its stable per-error key is `requestId`. Scans from
 * the end so we stop at the first (latest) hit. Tolerates blank lines and a
 * partially-written trailing line (JSON parse failures are skipped).
 */
export function findLatestErrorMarker(transcript: string): ErrorMarker | null {
  const lines = transcript.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let rec: {
      isApiErrorMessage?: boolean;
      apiErrorStatus?: number;
      requestId?: string;
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      rec.isApiErrorMessage === true &&
      rec.apiErrorStatus === 500 &&
      typeof rec.requestId === 'string' &&
      rec.requestId.length > 0
    ) {
      return { requestId: rec.requestId, apiErrorStatus: rec.apiErrorStatus };
    }
  }
  return null;
}

export interface ErrorWatchdog {
  /** Begin the periodic sweep (no-op if already started). */
  start(): void;
  /** Stop the periodic sweep. */
  stop(): void;
  /**
   * Run a single sweep now. Exposed for tests and one-off triggering. Returns
   * the number of attachments a NEW 500 fired on this pass (post-dedup).
   */
  sweepOnce(now?: number): Promise<number>;
}

export interface ErrorWatchdogConfig {
  registry: DurableRegistry;
  poster: SlackPoster;
  /** Sweep cadence (ms). Default: 600_000 (10 min). */
  sweepIntervalMs?: number;
  /** Override the projects dir root (tests). */
  projectsDir?: string;
  /** Override transcript reads (tests). Returns null when missing/unreadable. */
  readTranscript?: (path: string) => string | null;
  /** Override PID liveness probe (tests). Defaults to `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
}

export function createErrorWatchdog(
  config: ErrorWatchdogConfig,
): ErrorWatchdog {
  const {
    registry,
    poster,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    projectsDir = PROJECTS_DIR,
    readTranscript = defaultReadTranscript,
    isPidAlive = defaultIsPidAlive,
  } = config;

  let timer: ReturnType<typeof setInterval> | null = null;

  function isEligible(att: AttachmentRow): boolean {
    if (att.status !== 'active') return false;
    if (att.owner_mode !== 'terminal-attached') return false;
    if (!att.session_id) return false;
    if (att.cc_pid === null || !isPidAlive(att.cc_pid)) return false;
    return true;
  }

  /** Returns true when a NEW 500 fired (notify + nudge); false when deduped. */
  async function actOnError(
    att: AttachmentRow,
    marker: ErrorMarker,
    now: number,
  ): Promise<boolean> {
    // Mark-then-act: the dedup insert is the one-shot gate. A false return means
    // this requestId was already actioned — stay completely silent.
    const isNew = registry.tryRecordWatchdogError(
      att.id,
      marker.requestId,
      now,
    );
    if (!isNew) return false;

    console.log(
      `[agent-comms] error-watchdog: 500 detected attachment=${att.id} session=${att.session_id?.slice(0, 8) ?? '?'} req=${marker.requestId} → notify + nudge`,
    );

    // 1) Heads-up in the thread for the human. Phrased as a possibility so it
    //    reads fine even if the session was not actually frozen.
    await poster
      .postThreadMessage({
        channel: att.channel_id,
        threadTs: att.thread_ts,
        text: `:rotating_light: A transient \`500\` API error was found in this session's transcript (req \`${marker.requestId}\`). These can end a turn with no auto-resume, so I'm nudging the session to continue. _Harmless if it's already moving._`,
      })
      .catch((err: unknown) => {
        console.error(
          `[agent-comms] error-watchdog notify failed for attachment=${att.id}: ${(err as Error).message ?? String(err)}`,
        );
      });

    // 2) Inject the continue nudge through the inbound path — the session's
    //    `agent-comms monitor` long-poll leases and delivers it, waking an idle
    //    session exactly like a human Slack reply would. requiresResponse=false:
    //    delivery does not depend on it, and we don't want the heartbeat's
    //    "still working..." cadence firing for an automated nudge.
    try {
      registry.insertInboundMessage({
        attachmentId: att.id,
        direction: 'slack_to_agent',
        senderId: 'agent-comms-watchdog',
        text: CONTINUE_NUDGE_TEXT,
        requiresResponse: false,
        now,
      });
    } catch (err) {
      console.error(
        `[agent-comms] error-watchdog nudge-inject failed for attachment=${att.id}: ${(err as Error).message ?? String(err)}`,
      );
    }

    return true;
  }

  async function sweepOnce(now: number = Date.now()): Promise<number> {
    let attachments: AttachmentRow[];
    try {
      attachments = registry.listActiveAttachments();
    } catch (err) {
      console.error(
        `[agent-comms] error-watchdog: listActiveAttachments failed: ${(err as Error).message ?? String(err)}`,
      );
      return 0;
    }

    let fired = 0;
    for (const att of attachments) {
      // One bad attachment (unreadable transcript, etc.) must not abort the sweep.
      try {
        if (!isEligible(att)) continue;
        const path = transcriptPathFor(
          projectsDir,
          att.cwd,
          att.session_id as string,
        );
        const transcript = readTranscript(path);
        if (transcript === null) continue;
        const marker = findLatestErrorMarker(transcript);
        if (!marker) continue;
        if (await actOnError(att, marker, now)) fired++;
      } catch (err) {
        console.error(
          `[agent-comms] error-watchdog: sweep error for attachment=${att.id}: ${(err as Error).message ?? String(err)}`,
        );
      }
    }
    return fired;
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        sweepOnce().catch((err: unknown) => {
          console.error(
            `[agent-comms] error-watchdog sweep failed: ${(err as Error).message ?? String(err)}`,
          );
        });
      }, sweepIntervalMs);
      timer.unref(); // never keep the process alive on its own
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    sweepOnce,
  };
}

