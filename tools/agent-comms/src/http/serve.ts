/**
 * Shared Bun.serve settings for the agent-comms daemon.
 *
 * The monitor wait route long-polls for 25s. Bun's default idle timeout is
 * shorter than that, so the daemon must explicitly allow a longer idle window
 * or real clients see an empty connection close before the route returns JSON.
 */

import type { Hono } from 'hono';

export const AGENT_COMMS_SERVE_IDLE_TIMEOUT_SECONDS = 30;

export function serveHttpApp(params: {
  app: Hono;
  hostname?: string;
  port: number;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: params.hostname ?? '127.0.0.1',
    port: params.port,
    fetch: params.app.fetch,
    idleTimeout: AGENT_COMMS_SERVE_IDLE_TIMEOUT_SECONDS,
  });
}

