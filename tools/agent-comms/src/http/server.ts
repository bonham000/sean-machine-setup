import { Hono } from 'hono';
import type { HeartbeatManager } from '../slack/heartbeat';
import { agentCommsSecretAuth } from './auth';
import type { AskDeps } from './routes/ask';
import { askRoute } from './routes/ask';
import { type AttachDeps, attachRoute } from './routes/attach';
import type { AttachLiveDeps } from './routes/attach-live';
import { attachLiveRoute } from './routes/attach-live';
import type { HandledDeps } from './routes/handled';
import { handledRoute } from './routes/handled';
import { type HealthDeps, healthRoute } from './routes/health';
import type { MessagesDeps } from './routes/messages';
import { messagesRoute } from './routes/messages';
import type { MonitorDeps } from './routes/monitor';
import { monitorRoutes } from './routes/monitor';
import { postRoute } from './routes/post';
import type { ReplyDeps } from './routes/reply';
import { replyRoute } from './routes/reply';
import type { StatusDeps } from './routes/status';
import { statusRoute } from './routes/status';

export type ServerDeps = AttachDeps &
  HealthDeps &
  AskDeps &
  AttachLiveDeps &
  MessagesDeps &
  MonitorDeps &
  ReplyDeps &
  StatusDeps &
  HandledDeps & {
    /** Heartbeat manager — injected into reply/handled routes for immediate stop. */
    heartbeatManager?: HeartbeatManager;
  };

export function createHttpApp(deps: ServerDeps): Hono {
  const app = new Hono();

  app.route('/health', healthRoute(deps));

  // Authenticated routes
  const authenticated = new Hono();
  authenticated.use('*', agentCommsSecretAuth);
  authenticated.route('/attach', attachRoute(deps));
  authenticated.route('/post', postRoute(deps));
  // /ask: inject durableRegistry from deps for attachment precedence guard
  authenticated.route(
    '/ask',
    askRoute({ ...deps, durableRegistry: deps.registry }),
  );
  // /handoff: legacy alias kept for one migration cycle so stale slash commands still work.
  authenticated.route('/handoff', attachRoute(deps));

  // Phase 2: durable attachment + monitor surface
  authenticated.route('/attach-live', attachLiveRoute(deps));
  authenticated.route('/monitor', monitorRoutes(deps));
  // Body-fetch companion to /monitor — see routes/messages.ts header.
  authenticated.route('/messages', messagesRoute(deps));
  authenticated.route(
    '/reply',
    replyRoute({ ...deps, heartbeatManager: deps.heartbeatManager }),
  );
  authenticated.route('/status', statusRoute(deps));
  authenticated.route(
    '/handled',
    handledRoute({ ...deps, heartbeatManager: deps.heartbeatManager }),
  );

  app.route('/', authenticated);

  return app;
}

/**
 * Build a Slack thread permalink. When a `workspaceUrl` is supplied (e.g.
 * `https://priori-labs.slack.com/` from auth.test) the URL deep-links into
 * the user's workspace directly. The generic `https://slack.com/...` form is a
 * fallback for the brief window before slack.start() resolves auth.test.
 */
export function threadUrl(
  channel: string,
  ts: string,
  workspaceUrl?: string | null,
): string {
  const base =
    workspaceUrl && workspaceUrl.length > 0
      ? workspaceUrl
      : 'https://slack.com/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return `${normalized}archives/${channel}/p${ts.replace('.', '')}`;
}

