import { Hono } from 'hono';
import { countByStatus } from '../../registry';

export interface HealthDeps {
  machineId: string;
  /** Real Socket Mode connection state (driven by socket lifecycle events). */
  isSlackConnected: () => boolean;
  /** ms timestamp of the last confirmed Socket Mode connection, or null. */
  slackLastConnectedAt?: () => number | null;
}

export function healthRoute(deps: HealthDeps): Hono {
  const route = new Hono();
  route.get('/', (c) =>
    c.json({
      ok: true,
      machine_id: deps.machineId,
      slack_connected: deps.isSlackConnected(),
      slack_last_connected_at: deps.slackLastConnectedAt?.() ?? null,
      registry_count: countByStatus('active'),
    }),
  );
  return route;
}

