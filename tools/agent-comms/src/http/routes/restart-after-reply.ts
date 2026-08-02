/**
 * POST /restart-after-reply — queue one daemon self-restart after worker idle.
 *
 * This route is authenticated by the parent router. It deliberately does not
 * spawn launchctl helpers: the existing KeepAlive LaunchAgent relaunches the
 * daemon once this process exits cleanly.
 */

import { Hono } from 'hono';

export interface RestartAfterReplyDeps {
  requestRestartAfterReply?: () => { alreadyQueued: boolean };
}

export function restartAfterReplyRoute(
  deps: RestartAfterReplyDeps,
): Hono {
  const route = new Hono();

  route.post('/', (c) => {
    if (!deps.requestRestartAfterReply) {
      return c.json(
        { ok: false, error: 'restart-after-reply is unavailable' },
        503,
      );
    }

    const result = deps.requestRestartAfterReply();
    return c.json({
      ok: true,
      status: result.alreadyQueued ? 'already_queued' : 'queued',
    });
  });

  return route;
}
