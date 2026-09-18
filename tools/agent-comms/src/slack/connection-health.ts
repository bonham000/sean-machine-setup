/**
 * Socket Mode connection health — pure state + restart-decision logic.
 *
 * Background: the daemon's worst reliability failure was a Slack Socket Mode
 * WebSocket that dropped and never recovered. Bolt's internal reconnect loop
 * wedged (endless failing `apps.connections.open` retries), the process stayed
 * alive, and the daemon went silently deaf to every inbound Slack message.
 * `isConnected()` was a flag set once at startup, so `/health` cheerfully
 * reported `slack_connected: true` the entire time it was deaf.
 *
 * The fix is crash-only recovery: observe the *real* socket phase from the
 * SocketModeClient lifecycle events, and when the socket has been down past a
 * grace window, exit non-zero so launchd (KeepAlive=true) relaunches with a
 * fresh socket.
 *
 * Two corrections to the first version of that design, both driven by what the
 * logs actually recorded over four months (1,745 watchdog restarts):
 *
 *   1. **Anchor on when the socket went down, not on the last `hello`.**
 *      The old code measured downtime from `lastConnectedAt`, which only
 *      advances on a *new* connection. Slack routinely refreshes a Socket Mode
 *      connection every few hours; the client leaves the connected state for
 *      about a second and comes back. With the old anchor, a refresh after 4.7
 *      healthy hours computed `downMs = 4.7h`, blew past the 90s grace, and
 *      killed a perfectly healthy process. 32 of the 35 "disconnected for N"
 *      restarts in the log had N > 3600s — every one of them a routine
 *      refresh, not a wedge. `disconnectedSince` is stamped once, at the
 *      connected→disconnected edge, which fixes the measurement while keeping
 *      the original property that repeated `reconnecting` emissions must not
 *      reset the clock.
 *
 *   2. **Restarting cannot fix "the network is down".** 1,710 of the 1,745
 *      restarts were `never established a connection within 90s of startup` —
 *      the daemon crash-looping every 90 seconds through an outage it could do
 *      nothing about, each loop appending another burst of retry warnings.
 *      A process that has never connected gets a much longer grace, because
 *      Bolt reconnects on its own the moment the network returns; the short
 *      grace is reserved for the case it was built for, a socket that was
 *      working and then wedged.
 *
 * This module is the pure decision core (no timers, no `process`, no Slack) so
 * it can be unit-tested deterministically with an injected clock.
 */

/** Snapshot of the socket's observed connection state. */
export interface ConnectionStatus {
  /** True only while the socket is fully connected (Slack `hello` received). */
  connected: boolean;
  /** ms timestamp of the last confirmed connection, or null if never connected. */
  lastConnectedAt: number | null;
  /**
   * ms timestamp of the connected→disconnected edge, or null while connected
   * (or before the first connection). Stamped once per outage: the socket-mode
   * client emits `reconnecting` on every retry attempt, and re-stamping on each
   * one would reset the clock and mask a loop that never recovers.
   */
  disconnectedSince: number | null;
  /** ms timestamp the daemon process started (the anchor before first connect). */
  startedAt: number;
}

export interface RestartDecision {
  restart: boolean;
  reason: string | null;
}

export interface ConnectionThresholds {
  /**
   * How long a socket that *was* connected may stay down before we treat it as
   * wedged and restart. Normal reconnects complete in about a second, so this
   * only trips on a genuinely stuck client.
   */
  graceMs: number;
  /**
   * How long a process that has *never* connected waits before restarting.
   * Much longer than `graceMs`: this is the network-outage case, where exiting
   * achieves nothing and only costs another burst of startup log noise. Bolt
   * keeps retrying and connects on its own when the network returns; the
   * restart is a last resort for a client that is stuck rather than waiting.
   */
  startupGraceMs: number;
}

export const DEFAULT_CONNECTION_GRACE_MS = 90_000;
export const DEFAULT_STARTUP_GRACE_MS = 600_000;

/**
 * Decide whether the daemon should restart itself given the current socket
 * status. Pure: same inputs → same output.
 */
export function evaluateConnection(
  status: ConnectionStatus,
  now: number,
  thresholds: ConnectionThresholds,
): RestartDecision {
  if (status.connected) return { restart: false, reason: null };

  const neverConnected = status.lastConnectedAt === null;
  const anchor = neverConnected
    ? status.startedAt
    : (status.disconnectedSince ?? status.lastConnectedAt ?? status.startedAt);
  const graceMs = neverConnected
    ? thresholds.startupGraceMs
    : thresholds.graceMs;

  const downMs = now - anchor;
  if (downMs <= graceMs) return { restart: false, reason: null };

  const downSecs = Math.round(downMs / 1000);
  const reason = neverConnected
    ? `Socket Mode never established a connection within ${downSecs}s of startup`
    : `Socket Mode has been disconnected for ${downSecs}s without recovering`;
  return { restart: true, reason };
}
