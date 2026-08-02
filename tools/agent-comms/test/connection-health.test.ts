/**
 * Connection-health unit tests.
 *
 * The decision core is pure (injected clock, no timers/process/Slack), so these
 * pin down the exact restart boundary that keeps the daemon from going silently
 * deaf when the Socket Mode WebSocket wedges.
 */

import { describe, expect, it } from 'bun:test';
import {
  type ConnectionStatus,
  DEFAULT_CONNECTION_GRACE_MS,
  evaluateConnection,
} from '../src/slack/connection-health';

const GRACE = { graceMs: 90_000 };

describe('evaluateConnection', () => {
  it('never restarts while connected, however long ago that started', () => {
    const status: ConnectionStatus = {
      connected: true,
      lastConnectedAt: 1_000,
      startedAt: 0,
    };
    expect(evaluateConnection(status, 10_000_000, GRACE).restart).toBe(false);
  });

  it('holds through a brief disconnect inside the grace window', () => {
    const status: ConnectionStatus = {
      connected: false,
      lastConnectedAt: 100_000,
      startedAt: 0,
    };
    // 89s down — under the 90s grace.
    expect(evaluateConnection(status, 100_000 + 89_000, GRACE).restart).toBe(
      false,
    );
  });

  it('restarts once disconnected longer than the grace window', () => {
    const status: ConnectionStatus = {
      connected: false,
      lastConnectedAt: 100_000,
      startedAt: 0,
    };
    const decision = evaluateConnection(status, 100_000 + 91_000, GRACE);
    expect(decision.restart).toBe(true);
    expect(decision.reason).toContain('disconnected for 91s');
  });

  it('anchors on lastConnectedAt, so repeated reconnecting cannot reset the clock', () => {
    // Absolute time is large, but the anchor is the last good connection.
    const status: ConnectionStatus = {
      connected: false,
      lastConnectedAt: 500_000,
      startedAt: 0,
    };
    // 60s since last connect → still healthy despite a huge startedAt gap.
    expect(evaluateConnection(status, 560_000, GRACE).restart).toBe(false);
    // 120s since last connect → wedged, restart.
    expect(evaluateConnection(status, 620_000, GRACE).restart).toBe(true);
  });

  it('uses startedAt as the anchor when the socket never connected', () => {
    const status: ConnectionStatus = {
      connected: false,
      lastConnectedAt: null,
      startedAt: 10_000,
    };
    expect(evaluateConnection(status, 10_000 + 80_000, GRACE).restart).toBe(
      false,
    );
    const past = evaluateConnection(status, 10_000 + 100_000, GRACE);
    expect(past.restart).toBe(true);
    expect(past.reason).toContain('never established');
  });

  it('treats the boundary as inclusive (exactly graceMs is still healthy)', () => {
    const status: ConnectionStatus = {
      connected: false,
      lastConnectedAt: 0,
      startedAt: 0,
    };
    expect(evaluateConnection(status, 90_000, GRACE).restart).toBe(false);
    expect(evaluateConnection(status, 90_001, GRACE).restart).toBe(true);
  });

  it('ships a sane default grace window', () => {
    expect(DEFAULT_CONNECTION_GRACE_MS).toBe(90_000);
  });
});

