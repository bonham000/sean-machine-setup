/**
 * Coordinates a daemon self-restart requested by one of its headless agents.
 *
 * The request arrives while the requesting harness is still a child of this
 * process. Restarting immediately would kill that harness before its final
 * Slack reply is posted. The controller therefore waits until every daemon
 * worker turn is idle, then re-checks idleness immediately before restarting
 * to close the race with a newly-arrived Slack message.
 */

export interface RestartAfterReplyController {
  request(): { alreadyQueued: boolean };
  notifyWorkerIdle(): void;
  isPending(): boolean;
}

export interface RestartAfterReplyConfig {
  isWorkerIdle: () => boolean;
  restart: () => void;
  delayMs?: number;
}

const DEFAULT_RESTART_DELAY_MS = 250;

export function createRestartAfterReplyController(
  config: RestartAfterReplyConfig,
): RestartAfterReplyController {
  let pending = false;
  let scheduled = false;
  let restarting = false;

  function maybeSchedule(): void {
    if (restarting || scheduled || !pending || !config.isWorkerIdle()) return;

    scheduled = true;
    const timer = setTimeout(() => {
      scheduled = false;
      if (restarting || !pending) return;

      // A Slack event may have started a new turn after the idle notification.
      // Keep the request pending; that turn will notify us when it finishes.
      if (!config.isWorkerIdle()) return;

      restarting = true;
      config.restart();
    }, config.delayMs ?? DEFAULT_RESTART_DELAY_MS);
    timer.unref();
  }

  return {
    request() {
      const alreadyQueued = pending;
      pending = true;
      maybeSchedule();
      return { alreadyQueued };
    },
    notifyWorkerIdle() {
      maybeSchedule();
    },
    isPending() {
      return pending;
    },
  };
}
