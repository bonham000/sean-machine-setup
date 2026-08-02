/**
 * Slack agent-comms daemon — entrypoint.
 *
 * Boots the local HTTP server (Hono on 127.0.0.1) and the Slack Bolt app
 * (Socket Mode, outbound websocket). The /attach endpoint (and its legacy
 * /handoff alias), /post endpoint, and /ask endpoint post messages to
 * #agents via the Bolt WebClient; thread replies are routed through the
 * durable attachment inbox by slack/app.ts (Phase 3+).
 *
 * Usage: bun src/index.ts
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAskRegistry } from './asks';
import { loadConfig } from './config';
import { serveHttpApp } from './http/serve';
import { createHttpApp, threadUrl } from './http/server';
import { createDurableRegistry } from './registry';
import { ensureSecret } from './secret';
import { createSlackApp, type SlackAppHandle } from './slack/app';
import {
  DEFAULT_CONNECTION_GRACE_MS,
  evaluateConnection,
} from './slack/connection-health';
import { createDaemonWorker, type DaemonWorker } from './slack/daemon-worker';
import {
  createErrorWatchdog,
  type ErrorWatchdog,
} from './slack/error-watchdog';
import { createHeartbeatManager } from './slack/heartbeat';
import type { SlackPoster } from './slack/types';

ensureSecret();

const config = loadConfig();

const askRegistry = createAskRegistry();

const registry = createDurableRegistry({
  dbPath: join(homedir(), '.claude', 'agent-comms', 'registry.db'),
});

// Reconcile before serving: clear expired monitor ownership and reclaim
// any leased messages whose TTL expired mid-flight (covers daemon-restart
// crash-recovery). Must happen BEFORE Bun.serve so a new monitor connection
// cannot race with in-flight state from a previous daemon run.
const startNow = Date.now();
const reconcileResult = registry.reconcileOnStartup(startNow);
if (reconcileResult.expiredMonitorOwners.length > 0) {
  console.log(
    `[agent-comms] reconcileOnStartup: cleared ${reconcileResult.expiredMonitorOwners.length} expired monitor owner(s): ${reconcileResult.expiredMonitorOwners.join(', ')}`,
  );
}
if (reconcileResult.reclaimedMessageIds.length > 0) {
  console.log(
    `[agent-comms] reconcileOnStartup: reclaimed ${reconcileResult.reclaimedMessageIds.length} leased message(s) back to persisted: ${reconcileResult.reclaimedMessageIds.join(', ')}`,
  );
}

// Lazy poster: wraps slackHandle.getPoster() at call time, not at construction.
// This breaks the circular dependency between HeartbeatManager / DaemonWorker
// (both need a poster) and createSlackApp (which needs them as deps). By the
// time any heartbeat or worker actually posts to Slack, slackHandle is fully
// initialized.
let slackHandle: SlackAppHandle;
const lazyPoster: SlackPoster = {
  postOpener: (p) => slackHandle.getPoster().postOpener(p),
  postThreadMessage: (p) => slackHandle.getPoster().postThreadMessage(p),
};

const heartbeatManager = createHeartbeatManager({
  registry,
  poster: lazyPoster,
});

const daemonWorker: DaemonWorker = createDaemonWorker({
  registry,
  poster: lazyPoster,
});

// Transient-500 watchdog: periodically scans live terminal-attached sessions'
// transcripts for a 500 that ended a turn (the harness does not auto-resume),
// and once per error posts a heads-up + injects a "continue if blocked/frozen"
// nudge through the same inbound path a human Slack reply uses.
const errorWatchdog: ErrorWatchdog = createErrorWatchdog({
  registry,
  poster: lazyPoster,
});

slackHandle = createSlackApp(config, {
  askRegistry,
  registry,
  heartbeatManager,
  daemonWorker,
});

const slack = slackHandle;

const httpApp = createHttpApp({
  channelId: config.slackAgentCommsChannel,
  machineId: config.machineId,
  isSlackConnected: () => slack.isConnected(),
  slackLastConnectedAt: () => slack.getConnectionStatus().lastConnectedAt,
  poster: slack.getPoster(),
  registry,
  // Lazy resolve so we pick up the workspace URL captured during slack.start().
  threadUrl: (channel, ts) => threadUrl(channel, ts, slack.getWorkspaceUrl()),
  askRegistry,
  heartbeatManager,
});

const server = serveHttpApp({
  app: httpApp,
  port: config.port,
});

console.log(
  `[agent-comms] HTTP listening on 127.0.0.1:${server.port} (machine ${config.machineId})`,
);

// Periodic sweep: expire stale message leases and mark attachments whose
// monitor has gone silent (no long-poll or check-in for > 60s) as stale.
const STALE_SWEEP_INTERVAL_MS = 10_000;
const staleTimer = setInterval(() => {
  const now = Date.now();
  const reclaimedIds = registry.expireStaleLeases(now);
  if (reclaimedIds.length > 0) {
    console.log(
      `[agent-comms] lease-expired reclaim: ${reclaimedIds.length} message(s) → persisted: ${reclaimedIds.join(', ')}`,
    );
  }
  const staledIds = registry.sweepStaleAttachments(now);
  if (staledIds.length > 0) {
    console.log(
      `[agent-comms] monitor stale transition: attachment(s) ${staledIds.join(', ')} → stale (no check-in for >60s)`,
    );
  }
}, STALE_SWEEP_INTERVAL_MS);
staleTimer.unref(); // Don't keep process alive on its own

// Connection watchdog: the daemon's worst failure mode is a Slack Socket Mode
// WebSocket that drops and never recovers — Bolt's reconnect loop wedges, the
// process stays alive, and every inbound Slack message is silently unhandled.
// launchd's KeepAlive can't help because the process never exits. So we watch
// the real socket status and, once it has been down past the grace window,
// exit non-zero; launchd relaunches with a fresh socket and reconcileOnStartup
// restores any in-flight state on boot. (Verified: a clean restart cures the
// wedge that in-process reconnect could not.)
const SOCKET_GRACE_MS = Number(
  process.env.AGENT_COMMS_SOCKET_GRACE_MS ?? DEFAULT_CONNECTION_GRACE_MS,
);
const CONNECTION_CHECK_INTERVAL_MS = 15_000;
const connectionTimer = setInterval(() => {
  const decision = evaluateConnection(slack.getConnectionStatus(), Date.now(), {
    graceMs: SOCKET_GRACE_MS,
  });
  if (decision.restart) {
    console.error(
      `[agent-comms] connection watchdog: ${decision.reason} — exiting for launchd restart`,
    );
    process.exit(1);
  }
}, CONNECTION_CHECK_INTERVAL_MS);
connectionTimer.unref(); // Don't keep process alive on its own

errorWatchdog.start();
console.log(
  '[agent-comms] error-watchdog armed — 10-min sweep for transient-500 session freezes',
);

slack
  .start()
  .then(() =>
    console.log(
      `[agent-comms] Bolt + Socket Mode connected — listening for replies in channel ${config.slackAgentCommsChannel}`,
    ),
  )
  .catch((err) => {
    console.error(`[agent-comms] Slack failed to start: ${err.message ?? err}`);
    process.exit(1);
  });

const shutdown = (signal: string) => {
  console.log(`[agent-comms] ${signal} received, shutting down`);
  clearInterval(staleTimer);
  clearInterval(connectionTimer);
  errorWatchdog.stop();
  heartbeatManager.stopAll();
  // Reject all pending /ask requests before closing the server so clients get
  // a clean 503 rather than a connection reset.
  askRegistry.shutdownAll();
  server.stop();
  slack
    .stop()
    .catch(() => {
      /* swallow */
    })
    .finally(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
