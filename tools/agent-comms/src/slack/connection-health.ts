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
 * fresh socket. A clean process restart is deterministic; fighting Bolt's
 * wedged in-process reconnect is not — and we verified a restart cures it.
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
  /** ms timestamp the daemon process started (the anchor before first connect). */
  startedAt: number;
}

export interface RestartDecision {
  restart: boolean;
  reason: string | null;
}

export interface ConnectionThresholds {
  /**
   * How long the socket may stay disconnected — measured from the last
   * confirmed connection, or from process start if it never connected — before
   * we give up and restart. Normal reconnects complete in seconds, so this
   * only trips on a genuinely wedged socket.
   */
  graceMs: number;
}

export const DEFAULT_CONNECTION_GRACE_MS = 90_000;

/**
 * Decide whether the daemon should restart itself given the current socket
 * status. Pure: same inputs → same output.
 *
 * The down-time anchor is `lastConnectedAt` (not "time in the current phase")
 * on purpose: the socket-mode client emits `reconnecting` on *every* retry
 * attempt, so anchoring on the current phase's start would reset the clock each
 * retry and mask a reconnect loop that never actually recovers.
 */
export function evaluateConnection(
  status: ConnectionStatus,
  now: number,
  thresholds: ConnectionThresholds,
): RestartDecision {
  if (status.connected) return { restart: false, reason: null };

  const anchor = status.lastConnectedAt ?? status.startedAt;
  const downMs = now - anchor;
  if (downMs <= thresholds.graceMs) return { restart: false, reason: null };

  const downSecs = Math.round(downMs / 1000);
  const reason =
    status.lastConnectedAt === null
      ? `Socket Mode never established a connection within ${downSecs}s of startup`
      : `Socket Mode has been disconnected for ${downSecs}s without recovering`;
  return { restart: true, reason };
}

