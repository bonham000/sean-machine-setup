/**
 * Daemon log hygiene: timestamps + consecutive-duplicate collapsing.
 *
 * Background: the daemon's logs were a single unrotated file with no
 * timestamps. A network outage put Bolt's WebClient into a retry loop that
 * logged the same connect failure every few seconds, and launchd's KeepAlive
 * restarted the process on every watchdog exit, so each outage appended
 * thousands of identical lines. The file reached 36k lines across four months
 * and was useless for diagnosis: you could not tell a burst from May apart
 * from one this morning, and the real signal was buried.
 *
 * Two fixes, both here:
 *   1. Every line carries an ISO timestamp, so lines can be dated and
 *      correlated with Slack.
 *   2. A run of identical consecutive lines is collapsed into one line plus a
 *      periodic `repeated N×` summary, so a retry storm costs a handful of
 *      lines instead of thousands. Nothing is silently dropped — the count is
 *      always reported.
 *
 * The writer is pure with respect to its sink and clock so it can be tested
 * deterministically.
 */

import { format } from 'node:util';

export interface LogSink {
  write(line: string): void;
}

export interface CollapsingWriterOptions {
  sink: LogSink;
  /** Injected clock; defaults to wall time. */
  now?: () => number;
  /**
   * Emit a `repeated N×` summary once this many consecutive duplicates have
   * accumulated, so a storm that never changes message still reports progress
   * instead of going quiet indefinitely.
   */
  flushEvery?: number;
}

export interface CollapsingWriter {
  write(message: string): void;
  /** Emit any pending duplicate summary (called on shutdown). */
  flush(): void;
}

export const DEFAULT_FLUSH_EVERY = 100;

function stamp(now: () => number, message: string): string {
  return `${new Date(now()).toISOString()} ${message}`;
}

/**
 * Wrap a sink so identical consecutive messages collapse.
 *
 * A changed message always flushes the pending summary first, so the output
 * order stays faithful: you see the repeated line, then how many times it
 * repeated, then whatever came next.
 */
export function createCollapsingWriter(
  options: CollapsingWriterOptions,
): CollapsingWriter {
  const now = options.now ?? Date.now;
  const flushEvery = options.flushEvery ?? DEFAULT_FLUSH_EVERY;
  let lastMessage: string | null = null;
  let repeats = 0;

  function flush(): void {
    if (repeats === 0) return;
    const count = repeats;
    repeats = 0;
    options.sink.write(
      stamp(now, `[agent-comms] ↑ previous line repeated ${count}× (collapsed)`),
    );
  }

  return {
    write(message) {
      if (message === lastMessage) {
        repeats += 1;
        if (repeats >= flushEvery) flush();
        return;
      }
      flush();
      lastMessage = message;
      options.sink.write(stamp(now, message));
    },
    flush,
  };
}

export interface InstalledConsole {
  /** Flush pending duplicate summaries on both streams. */
  flush(): void;
  /** Restore the original console methods (tests). */
  restore(): void;
}

/**
 * Route console output through timestamped collapsing writers.
 *
 * Patching the global console (rather than introducing a logger the daemon
 * code must adopt) is deliberate: the loudest writer by far is the Slack
 * SDK's own ConsoleLogger, which we do not own. Patching the sink catches
 * every line from every dependency.
 */
export function installTimestampedConsole(
  options: { flushEvery?: number; now?: () => number } = {},
): InstalledConsole {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  const out = createCollapsingWriter({
    sink: { write: (line) => original.log(line) },
    now: options.now,
    flushEvery: options.flushEvery,
  });
  const err = createCollapsingWriter({
    sink: { write: (line) => original.error(line) },
    now: options.now,
    flushEvery: options.flushEvery,
  });

  console.log = (...args: unknown[]) => out.write(format(...args));
  console.info = (...args: unknown[]) => out.write(format(...args));
  console.debug = (...args: unknown[]) => out.write(format(...args));
  console.warn = (...args: unknown[]) => err.write(format(...args));
  console.error = (...args: unknown[]) => err.write(format(...args));

  return {
    flush() {
      out.flush();
      err.flush();
    },
    restore() {
      console.log = original.log;
      console.info = original.info;
      console.debug = original.debug;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}
