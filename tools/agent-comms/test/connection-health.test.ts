/**
 * Connection-health unit tests.
 *
 * The decision core is pure (injected clock, no timers/process/Slack), so these
 * pin down the exact restart boundary that keeps the daemon from going silently
 * deaf when the Socket Mode WebSocket wedges — without killing a healthy
 * process, which is what the first version of this logic did.
 */

import { describe, expect, it } from 'bun:test';
import {
  type ConnectionStatus,
  evaluateConnection,
} from '../src/slack/connection-health';

const THRESHOLDS = { graceMs: 90_000, startupGraceMs: 600_000 };

function status(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    connected: false,
    lastConnectedAt: null,
    disconnectedSince: null,
    startedAt: 0,
    ...overrides,
  };
}

describe('evaluateConnection', () => {
  it('never restarts while connected, however long ago that started', () => {
    const live = status({ connected: true, lastConnectedAt: 1_000 });
    expect(evaluateConnection(live, 10_000_000, THRESHOLDS).restart).toBe(false);
  });

  it('holds through a brief disconnect inside the grace window', () => {
    const brief = status({
      lastConnectedAt: 100_000,
      disconnectedSince: 100_000,
    });
    expect(
      evaluateConnection(brief, 100_000 + 89_000, THRESHOLDS).restart,
    ).toBe(false);
  });

  it('restarts a socket that was connected and stayed down past the grace', () => {
    const wedged = status({
      lastConnectedAt: 100_000,
      disconnectedSince: 100_000,
    });
    const decision = evaluateConnection(wedged, 100_000 + 91_000, THRESHOLDS);
    expect(decision.restart).toBe(true);
    expect(decision.reason).toContain('disconnected for 91s');
  });

  /**
   * Regression. Slack refreshes a Socket Mode connection every few hours; the
   * client leaves the connected state for about a second and comes straight
   * back. The old code anchored downtime on `lastConnectedAt`, so a refresh
   * after five healthy hours measured `downMs` as five hours, blew past the
   * grace, and killed a working process. 32 restarts in the shipped log were
   * this exact case.
   */
  it('measures downtime from the disconnect, not from the last handshake', () => {
    const fiveHours = 5 * 60 * 60 * 1000;
    const justDropped = status({
      lastConnectedAt: 1_000,
      disconnectedSince: 1_000 + fiveHours,
    });
    const decision = evaluateConnection(
      justDropped,
      1_000 + fiveHours + 2_000,
      THRESHOLDS,
    );
    expect(decision.restart).toBe(false);
  });

  it('keeps one anchor across a retry loop so repeats cannot hide a wedge', () => {
    // `disconnectedSince` is stamped once at the edge; the client emitting
    // `reconnecting` again must not push the deadline out.
    const looping = status({
      lastConnectedAt: 500_000,
      disconnectedSince: 500_000,
    });
    expect(evaluateConnection(looping, 560_000, THRESHOLDS).restart).toBe(false);
    expect(evaluateConnection(looping, 620_000, THRESHOLDS).restart).toBe(true);
  });

  /**
   * Regression. 1,710 of the 1,745 restarts in the shipped log were a process
   * that never connected, exiting after 90s into a network outage that a
   * restart could not fix — then doing it again, every 90 seconds, each loop
   * appending another burst of retry warnings.
   */
  it('gives a process that never connected the long startup grace', () => {
    const cold = status({ startedAt: 10_000 });
    expect(evaluateConnection(cold, 10_000 + 120_000, THRESHOLDS).restart).toBe(
      false,
    );

    const past = evaluateConnection(cold, 10_000 + 601_000, THRESHOLDS);
    expect(past.restart).toBe(true);
    expect(past.reason).toContain('never established');
  });

  it('treats the boundary as inclusive (exactly graceMs is still healthy)', () => {
    const edge = status({ lastConnectedAt: 0, disconnectedSince: 0 });
    expect(evaluateConnection(edge, 90_000, THRESHOLDS).restart).toBe(false);
    expect(evaluateConnection(edge, 90_001, THRESHOLDS).restart).toBe(true);
  });
});
