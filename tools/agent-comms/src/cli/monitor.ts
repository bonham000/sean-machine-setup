/**
 * agent-comms monitor — long-poll the daemon for inbound Slack messages.
 *
 * Emits one structured **notification** line per leased message (id + metadata
 * only, NO body), HTTP-acks emitted before fetching the next, and sends a
 * check-in every 15s to keep the daemon liveness window alive.
 *
 * The body is intentionally not packed into the stdout line. Claude Code's
 * Monitor tool applies a small per-event stdout cap that clips long lines
 * with a literal `...(truncated)` suffix — small enough that real Slack
 * messages routinely overflow when inlined here. The notification stays
 * under that cap; CC fetches the full body via `agent-comms get-message
 * --message-id <id>` over Bash (which has a much larger output cap).
 *
 * Stdout format per message:
 *   [agent-comms] msg=<id> attach=<attach_id> from=<slack_user_id> slack_ts=<ts> chars=<n>
 *
 * Exit codes:
 *   0 — clean stop (not expected in normal use; monitor runs until interrupted)
 *   1 — daemon error (400 / 502 / etc.)
 *   2 — bad args
 *   3 — daemon not running
 *   4 — 404 attachment not found
 *   7 — 409 monitor already owned by another process
 */

import type { MonitorArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

const CHECKIN_INTERVAL_MS = 15_000;
const TRANSIENT_RETRY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getDefaultMonitorOwnerToken(attachmentId: string): string {
  return `monitor:${attachmentId}`;
}

export async function runMonitor(
  args: MonitorArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });

  const ownerToken =
    args.ownerToken ?? getDefaultMonitorOwnerToken(args.attachmentId);
  const pid = process.pid;
  const startedAt = Date.now();
  let hasConnected = false;

  // Track emitted-but-not-yet-acked ids for check-in reconciliation.
  // In practice we ack immediately after emit, so this is usually empty.
  const emittedNotAcked = new Set<string>();

  // Send an initial check-in to register liveness immediately, then
  // start the periodic interval.
  const sendCheckin = async () => {
    const result = await client.monitorCheckin(args.attachmentId, {
      owner_token: ownerToken,
      pid,
      started_at: startedAt,
      emitted_ids: [...emittedNotAcked],
    });
    if (!result.ok) {
      // Log but don't exit — stale check-in is recoverable
      process.stderr.write(
        `agent-comms monitor: check-in rejected (${result.status}): ${result.error}\n`,
      );
    }
  };

  // Check-in interval — fires independently of long-poll loop
  const checkinTimer = setInterval(() => {
    void sendCheckin();
  }, CHECKIN_INTERVAL_MS);

  // Ensure timers don't keep the process alive if the main loop exits
  checkinTimer.unref();

  let running = true;
  let currentWait: AbortController | null = null;

  const cleanup = () => {
    running = false;
    currentWait?.abort();
    clearInterval(checkinTimer);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    while (running) {
      const waitController = new AbortController();
      currentWait = waitController;
      const result = await client.monitorWait({
        attachmentId: args.attachmentId,
        ownerToken,
        pid,
        startedAt,
        signal: waitController.signal,
      });
      if (currentWait === waitController) currentWait = null;

      if (!running) break;

      if (!result.ok) {
        if (result.status === -1) {
          if (hasConnected) {
            process.stderr.write(
              `agent-comms monitor: transient daemon connection failure, retrying in ${TRANSIENT_RETRY_MS}ms: ${result.error}\n`,
            );
            await sleep(TRANSIENT_RETRY_MS);
            continue;
          }
          process.stderr.write(`agent-comms monitor: ${result.error}\n`);
          process.exitCode = 3;
          return;
        }
        if (result.status === 404) {
          process.stderr.write(
            `agent-comms monitor: attachment ${args.attachmentId} not found\n`,
          );
          process.exitCode = 4;
          return;
        }
        if (result.status === 409) {
          process.stderr.write(
            `agent-comms monitor: attachment already owned by another live monitor process — exit 7\n`,
          );
          process.exitCode = 7;
          return;
        }
        process.stderr.write(
          `agent-comms monitor: daemon error (${result.status}): ${result.error}\n`,
        );
        process.exitCode = 1;
        return;
      }

      hasConnected = true;

      for (const msg of result.messages) {
        // Mark as in-flight before emitting to stdout
        emittedNotAcked.add(msg.id);

        // Notification-only — body NEVER goes through Monitor stdout (CC's
        // per-event cap silently clips it). CC must read the body via
        // `agent-comms get-message --message-id <id>` over Bash.
        const from = msg.sender_id ?? 'unknown';
        const ts = msg.slack_ts ?? 'n/a';
        const chars = (msg.text ?? '').length;
        process.stdout.write(
          `[agent-comms] msg=${msg.id} attach=${msg.attachment_id} from=${from} slack_ts=${ts} chars=${chars}\n`,
        );

        // Ack emitted immediately so the daemon can advance message state
        const ackResult = await client.monitorEmitted({
          owner_token: ownerToken,
          message_ids: [msg.id],
        });
        emittedNotAcked.delete(msg.id);

        if (!ackResult.ok) {
          process.stderr.write(
            `agent-comms monitor: emitted ack failed for ${msg.id}: ${ackResult.error}\n`,
          );
        }
      }
    }
  } finally {
    cleanup();
  }
}

