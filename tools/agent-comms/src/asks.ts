/**
 * In-memory pending-ask resolver registry.
 *
 * Each `/ask` HTTP request reserves a slot keyed by thread_ts. When the
 * Slack message handler sees a reply in that thread it calls resolve(), which
 * unblocks the held HTTP request. Timeout, cancel, and shutdown all clear the
 * slot exactly once so there are no double-resolve races.
 */

export interface AskReserved {
  /** Resolves with the reply text when the user replies, or rejects on timeout/shutdown/cancel. */
  promise: Promise<string>;
  /** Cancel the reservation before it resolves (e.g. on client abort). */
  cancel: (reason: string) => void;
}

export type ReserveResult =
  | ({ ok: true } & AskReserved)
  | { ok: false; error: 'already_pending' };

export interface AskRegistry {
  /**
   * Reserve a pending ask for `threadTs`.
   * Returns `{ ok: false, error: 'already_pending' }` if one already exists.
   * `timeoutMs = 0` means indefinite (no timeout timer installed).
   */
  reserve(threadTs: string, opts: { timeoutMs: number }): ReserveResult;
  /**
   * Resolve the pending ask with the user's reply text.
   * Returns `true` if an active ask was resolved, `false` if none was found.
   */
  resolve(threadTs: string, replyText: string): boolean;
  /** Returns true if there is a pending ask for this thread. */
  hasPending(threadTs: string): boolean;
  /** Cancel the pending ask for this thread (no-op if none). */
  cancel(threadTs: string, reason: string): void;
  /** Reject all pending asks (e.g. on daemon shutdown). */
  shutdownAll(reason?: string): void;
}

interface AskEntry {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createAskRegistry(): AskRegistry {
  const pending = new Map<string, AskEntry>();

  function clearEntry(threadTs: string): void {
    const entry = pending.get(threadTs);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    pending.delete(threadTs);
  }

  return {
    reserve(threadTs, { timeoutMs }) {
      if (pending.has(threadTs)) {
        return { ok: false, error: 'already_pending' };
      }

      let res!: (text: string) => void;
      let rej!: (err: Error) => void;
      const promise = new Promise<string>((resolve, reject) => {
        res = resolve;
        rej = reject;
      });

      const entry: AskEntry = { resolve: res, reject: rej };

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (pending.has(threadTs)) {
            pending.delete(threadTs);
            rej(new Error('timed_out'));
          }
        }, timeoutMs);
      }

      pending.set(threadTs, entry);

      const cancel = (reason: string) => {
        if (pending.has(threadTs)) {
          clearEntry(threadTs);
          rej(new Error(reason));
        }
      };

      return { ok: true, promise, cancel };
    },

    resolve(threadTs, replyText) {
      const entry = pending.get(threadTs);
      if (!entry) return false;
      clearEntry(threadTs);
      entry.resolve(replyText);
      return true;
    },

    hasPending(threadTs) {
      return pending.has(threadTs);
    },

    cancel(threadTs, reason) {
      const entry = pending.get(threadTs);
      if (!entry) return;
      clearEntry(threadTs);
      entry.reject(new Error(reason));
    },

    shutdownAll(reason = 'daemon_shutdown') {
      for (const [threadTs, entry] of pending) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.reject(new Error(reason));
        pending.delete(threadTs);
      }
    },
  };
}

/** Production singleton — import this in production callers. */
export const askRegistry: AskRegistry = createAskRegistry();

