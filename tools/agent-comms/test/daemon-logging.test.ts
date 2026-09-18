/**
 * Log-hygiene tests.
 *
 * Both behaviors here are load-bearing for diagnosis rather than cosmetic, and
 * both have a failure mode that loses evidence:
 *
 *  - The collapsing writer must never drop a line without reporting the count.
 *    A retry storm produced 32,407 identical lines in the shipped log; the fix
 *    only helps if the suppressed count is always visible.
 *  - Rotation truncates a file in place, because launchd owns the descriptor.
 *    That is an irreversible operation on a file we do not exclusively own, so
 *    the copy-then-truncate ordering and the size threshold are worth pinning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateIfOversized } from '../src/daemon/log-rotate';
import { createCollapsingWriter } from '../src/daemon/logging';

function capture() {
  const lines: string[] = [];
  const writer = createCollapsingWriter({
    sink: { write: (line) => lines.push(line) },
    now: () => 0,
    flushEvery: 5,
  });
  return { lines, writer };
}

describe('collapsing log writer', () => {
  it('emits a changed line immediately, with a timestamp', () => {
    const { lines, writer } = capture();
    writer.write('first');
    writer.write('second');
    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z first',
      '1970-01-01T00:00:00.000Z second',
    ]);
  });

  it('collapses a run of identical lines and reports the count', () => {
    const { lines, writer } = capture();
    for (let i = 0; i < 4; i += 1) writer.write('ECONNREFUSED');
    writer.write('recovered');

    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z ECONNREFUSED',
      '1970-01-01T00:00:00.000Z [agent-comms] ↑ previous line repeated 3× (collapsed)',
      '1970-01-01T00:00:00.000Z recovered',
    ]);
  });

  it('reports progress during a storm that never changes message', () => {
    const { lines, writer } = capture();
    // flushEvery = 5: one printed line, then a summary per five suppressed.
    for (let i = 0; i < 11; i += 1) writer.write('same');
    expect(lines.filter((l) => l.includes('repeated 5×')).length).toBe(2);
  });

  it('accounts for every suppressed line when flushed at shutdown', () => {
    const { lines, writer } = capture();
    writer.write('x');
    writer.write('x');
    writer.write('x');
    writer.flush();
    expect(lines.at(-1)).toContain('repeated 2×');
  });
});

describe('log rotation', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-comms-logs-'));
    logPath = join(dir, 'stdout.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves a log under the threshold untouched', () => {
    writeFileSync(logPath, 'small');
    const result = rotateIfOversized(logPath, 1024);
    expect(result.rotated).toBe(false);
    expect(readFileSync(logPath, 'utf8')).toBe('small');
  });

  it('moves an oversized log aside and truncates the original in place', () => {
    const content = 'x'.repeat(2048);
    writeFileSync(logPath, content);
    const inodeBefore = statSync(logPath).ino;

    const result = rotateIfOversized(logPath, 1024);

    expect(result.rotated).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe(content);
    expect(statSync(logPath).size).toBe(0);
    // launchd holds this descriptor for the life of the process: a rename
    // would leave it writing to the rotated file forever.
    expect(statSync(logPath).ino).toBe(inodeBefore);
  });

  it('is a no-op when the log does not exist yet', () => {
    expect(rotateIfOversized(join(dir, 'missing.log'), 1).rotated).toBe(false);
  });
});
