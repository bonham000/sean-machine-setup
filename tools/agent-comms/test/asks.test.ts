import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AskRegistry } from '../src/asks';
import { createAskRegistry } from '../src/asks';

describe('AskRegistry', () => {
  let reg: AskRegistry;

  beforeEach(() => {
    reg = createAskRegistry();
  });

  it('reserve returns a promise that resolves on resolve()', async () => {
    const result = reg.reserve('t1', { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    reg.resolve('t1', 'hello');
    const reply = await result.promise;
    expect(reply).toBe('hello');
  });

  it('hasPending returns true after reserve, false after resolve', () => {
    reg.reserve('t2', { timeoutMs: 5000 });
    expect(reg.hasPending('t2')).toBe(true);
    reg.resolve('t2', 'x');
    expect(reg.hasPending('t2')).toBe(false);
  });

  it('resolve returns true when an active ask exists', () => {
    reg.reserve('t3', { timeoutMs: 5000 });
    expect(reg.resolve('t3', 'reply')).toBe(true);
  });

  it('resolve returns false when no ask is pending', () => {
    expect(reg.resolve('nonexistent', 'reply')).toBe(false);
  });

  it('duplicate reserve for same thread returns already_pending', () => {
    reg.reserve('t4', { timeoutMs: 5000 });
    const second = reg.reserve('t4', { timeoutMs: 5000 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe('already_pending');
    // Clean up
    reg.resolve('t4', 'done');
  });

  it('cancel rejects the promise with the given reason', async () => {
    const result = reg.reserve('t5', { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.cancel('client_aborted');
    await expect(result.promise).rejects.toThrow('client_aborted');
    expect(reg.hasPending('t5')).toBe(false);
  });

  it('cancel via returned cancel fn is idempotent (double-cancel no-ops)', async () => {
    const result = reg.reserve('t6', { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Attach rejection handler BEFORE cancelling so Bun does not see an
    // unhandled rejection between the cancel call and the await below.
    const settled = result.promise.catch((e: Error) => e.message);

    result.cancel('reason1');
    // Second cancel must not throw
    expect(() => result.cancel('reason2')).not.toThrow();

    const reason = await settled;
    expect(reason).toBe('reason1');
    expect(reg.hasPending('t6')).toBe(false);
  });

  it('reg.cancel is a no-op for unknown thread', () => {
    expect(() => reg.cancel('unknown', 'reason')).not.toThrow();
  });

  it('timeout fires and rejects the promise', async () => {
    const result = reg.reserve('t7', { timeoutMs: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await expect(result.promise).rejects.toThrow('timed_out');
    expect(reg.hasPending('t7')).toBe(false);
  });

  it('timeoutMs = 0 means no timeout timer (resolve manually)', async () => {
    const result = reg.reserve('t8', { timeoutMs: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Still pending after a short delay
    await new Promise((r) => setTimeout(r, 20));
    expect(reg.hasPending('t8')).toBe(true);

    reg.resolve('t8', 'late-reply');
    const reply = await result.promise;
    expect(reply).toBe('late-reply');
  });

  it('shutdownAll rejects all pending asks with daemon_shutdown', async () => {
    const r1 = reg.reserve('s1', { timeoutMs: 60_000 });
    const r2 = reg.reserve('s2', { timeoutMs: 60_000 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    reg.shutdownAll();

    await expect(r1.promise).rejects.toThrow('daemon_shutdown');
    await expect(r2.promise).rejects.toThrow('daemon_shutdown');
    expect(reg.hasPending('s1')).toBe(false);
    expect(reg.hasPending('s2')).toBe(false);
  });

  it('shutdownAll with custom reason rejects with that reason', async () => {
    const r = reg.reserve('s3', { timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    reg.shutdownAll('custom_reason');
    await expect(r.promise).rejects.toThrow('custom_reason');
  });

  it('entries from different threads are independent', async () => {
    const r1 = reg.reserve('ind1', { timeoutMs: 60_000 });
    const r2 = reg.reserve('ind2', { timeoutMs: 60_000 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    reg.resolve('ind1', 'reply-1');
    const reply1 = await r1.promise;
    expect(reply1).toBe('reply-1');

    // ind2 is still pending
    expect(reg.hasPending('ind2')).toBe(true);
    reg.resolve('ind2', 'reply-2');
    const reply2 = await r2.promise;
    expect(reply2).toBe('reply-2');
  });

  afterEach(() => {
    // Shut down any lingering timers
    reg.shutdownAll('test_cleanup');
  });
});

