/**
 * Slack Bolt + Socket Mode wiring for the agent-comms daemon.
 *
 * Listens on `message` events in #agents and routes thread replies
 * (from allow-listed users only) to the durable attachment inbox or the
 * legacy non-attached ask flow.
 *
 * Defense-in-depth ordering:
 *   1. Channel match
 *   2. thread_ts present (parent messages are ignored — only replies count)
 *   3. Skip self / bot messages
 *   4. Allow-list user check       ← BEFORE registry, so non-allowlisted
 *                                     users can't even probe thread existence
 *   5. routeThreadReply precedence ladder ← handled by routeThreadReply
 *
 * Phase 3 routing ladder (in routeThreadReply):
 *   1. Active durable attachment   → persist to messages inbox, react 📥, heartbeat
 *   2. Legacy handoffs row only    → post "please re-attach" message, do not resume
 *   3. Non-attached pending ask    → resolve ask, react ✅
 *   4. Otherwise                  → ignore
 *
 * Live terminal attachments never spawn a second harness process. Daemon-owned
 * headless attachments enqueue serialized turns in DaemonWorker.
 */

import { App, SocketModeReceiver } from '@slack/bolt';
import type { AskRegistry } from '../asks';
import type { Config } from '../config';
import type { DurableRegistry, MessageRow, Registry } from '../registry';
import type { ConnectionStatus } from './connection-health';
import type { DaemonWorker } from './daemon-worker';
import type { HeartbeatManager } from './heartbeat';
import type { SlackPoster, SlackReactor } from './types';

type BoltWebClient = App['client'];

/** Strip leading bot @-mentions of the form `<@U…>` from message text. */
function stripMentionPrefix(text: string): string {
  return text.replace(/^(?:<@[A-Z0-9]+>\s*)+/, '').trim();
}

function createBoltPoster(client: BoltWebClient): SlackPoster {
  return {
    async postOpener(params) {
      const res = await client.chat.postMessage({
        channel: params.channel,
        text: params.text,
      });
      if (!res.ts) throw new Error('chat.postMessage returned no ts');
      return { ts: res.ts };
    },
    async postThreadMessage(params) {
      const res = await client.chat.postMessage({
        channel: params.channel,
        thread_ts: params.threadTs,
        text: params.text,
      });
      if (!res.ts) throw new Error('chat.postMessage returned no ts');
      return { ts: res.ts };
    },
  };
}

function createBoltReactor(client: BoltWebClient): SlackReactor {
  return {
    async addReaction(params) {
      await client.reactions.add({
        channel: params.channel,
        timestamp: params.timestamp,
        name: params.name,
      });
    },
  };
}

// ---- Pure routing function (exported for tests) -------------------------

export interface RouteThreadReplyArgs {
  threadTs: string;
  channel: string;
  /** Slack ts of this specific message — used for reactions. */
  ts: string;
  text: string;
  /** Slack user id of the sender — stored as senderId in the durable inbox. */
  userId?: string;
  selfBotUserId: string | undefined;
  /** Used to post messages into the thread (re-attach notice, @-mention clarification). */
  poster: SlackPoster;
  /** Legacy handoffs registry — consulted only when no active attachment is found. */
  registry: Registry;
  /**
   * Durable registry for active-attachment lookup and inbound message persistence.
   * Pass null in environments where the durable surface is not yet available.
   */
  durableRegistry: DurableRegistry | null;
  askRegistry: AskRegistry;
  reactor: SlackReactor;
  /**
   * Heartbeat manager to start when an inbound message is persisted to the
   * durable inbox of a monitor-delivered attachment. Pass null when heartbeats
   * are not needed (e.g. tests).
   */
  heartbeatManager: HeartbeatManager | null;
  /**
   * Daemon worker to kick when an inbound message lands on a daemon-spawned
   * attachment (delivery_adapter === 'daemon-worker'). The worker resumes the
   * attachment's selected harness and posts the answer; no monitor is involved,
   * so the regular heartbeatManager is NOT started for these. Pass null in
   * tests; daemon-worker attachments will then go unprocessed.
   */
  daemonWorker: DaemonWorker | null;
}

/**
 * Route an incoming Slack thread reply after channel/thread/bot/allowlist gates.
 *
 * Precedence ladder:
 *   1. Active durable attachment for (channel, thread_ts)
 *      → persist to messages inbox, react 📥, start heartbeat
 *   2. Legacy handoffs row but no active attachment
 *      → post "please re-attach via /slack-attach-session", do not resume
 *   3. Non-attached pending ask (AFK flows — preserved from v1)
 *      → resolve ask, react ✅
 *   4. Otherwise → ignore
 *
 * Harness processes are never spawned synchronously from this function. It
 * only persists the message and enqueues the attachment's serial worker.
 */
export async function routeThreadReply(
  args: RouteThreadReplyArgs,
): Promise<void> {
  const { threadTs, channel, ts, text, userId, selfBotUserId } = args;

  // ── 1. Routable durable attachment (active OR stale) ──────────────────────
  // Stale attachments still receive inbound messages — the heartbeat surfaces
  // a stale notice in Slack rather than the daemon silently dropping the
  // reply. Active and stale routes share the same persist + react + heartbeat
  // path; heartbeat decides what copy to post based on attachment status.

  if (args.durableRegistry) {
    const attachment =
      args.durableRegistry.findRoutableAttachmentByChannelThread(
        channel,
        threadTs,
      );

    if (attachment) {
      // Bot @-mention inside an active attached thread — clarify, do not persist
      if (selfBotUserId && new RegExp(`^\\s*<@${selfBotUserId}>`).test(text)) {
        await args.poster
          .postThreadMessage({
            channel,
            threadTs,
            text: '_It looks like you @-mentioned me in this thread — did you mean to send that here, or in the main channel?_',
          })
          .catch(() => {
            /* swallow — clarification is best-effort */
          });
        return;
      }

      // Persist to durable inbox. The UNIQUE constraint on (attachment_id, slack_ts)
      // makes duplicate Slack event delivery idempotent — constraint violation = ignore.
      // Other errors (FK, schema, disk) MUST surface so they get logged and don't
      // silently lose Slack messages.
      let message: MessageRow;
      try {
        message = args.durableRegistry.insertInboundMessage({
          attachmentId: attachment.id,
          direction: 'slack_to_agent',
          slackTs: ts,
          senderId: userId,
          text,
          requiresResponse: true,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('UNIQUE constraint failed')) {
          // Duplicate Slack event for this thread ts — already persisted.
          return;
        }
        console.error(
          `[agent-comms] insertInboundMessage failed: attachment=${attachment.id} slack_ts=${ts} err=${errMsg}`,
        );
        throw err;
      }

      // React with 📥 to signal the message is received and queued.
      await args.reactor
        .addReaction({ channel, timestamp: ts, name: 'inbox_tray' })
        .catch(() => {
          /* swallow — reaction is best-effort */
        });

      // daemon-worker attachments post their own _thinking..._ via runTurn
      // and have no monitor; the regular heartbeat would erroneously fire
      // stale notices, so it's skipped for that branch.
      if (attachment.delivery_adapter === 'daemon-worker') {
        if (args.daemonWorker) {
          args.daemonWorker.kick({
            attachmentId: attachment.id,
            messageId: message.id,
          });
        } else {
          console.error(
            `[agent-comms] daemon-worker attachment ${attachment.id} received message ${message.id} but no DaemonWorker is wired in — message will sit unprocessed`,
          );
        }
      } else {
        args.heartbeatManager?.start({
          messageId: message.id,
          attachmentId: attachment.id,
          channel,
          threadTs,
          createdAt: message.created_at,
        });
      }

      return;
    }
  }

  // ── 2. Legacy handoffs row (no active durable attachment) ──────────────────

  const handoffRow = args.registry.findByThreadTs(threadTs);
  if (
    handoffRow &&
    (handoffRow.status === 'active' || handoffRow.status === 'errored')
  ) {
    // The user can't "re-attach" their way out — there is no live CC session
    // bound to this thread, and current @-mentions create a durable
    // attachment that hits the branch above. Only true v1 rows from prior
    // installs land here.
    await args.poster
      .postThreadMessage({
        channel,
        threadTs,
        text: '_This thread is from a previous version of agent-comms and is no longer connected to a live session. @-mention me again in the channel to start a new conversation._',
      })
      .catch(() => {
        /* swallow — best-effort */
      });
    console.log(
      `[agent-comms] legacy-handoff dead-thread notice: thread=${threadTs} status=${handoffRow.status}`,
    );
    return;
  }

  // ── 3. Non-attached pending-ask resolution (AFK flows) ─────────────────────

  if (args.askRegistry.hasPending(threadTs)) {
    args.askRegistry.resolve(threadTs, text);
    await args.reactor
      .addReaction({ channel, timestamp: ts, name: 'white_check_mark' })
      .catch(() => {
        /* swallow — reaction is best-effort */
      });
    return;
  }

  // ── 4. No matching context — ignore silently ──────────────────────────────
}

// ---- SlackAppHandle (production wiring) ----------------------------------

export interface SlackAppHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  postOpener(params: {
    channel: string;
    text: string;
  }): Promise<{ ts: string }>;
  postThreadMessage(params: {
    channel: string;
    threadTs: string;
    text: string;
  }): Promise<{ ts: string }>;
  /** Bolt-backed SlackPoster for HTTP route injection. */
  getPoster(): SlackPoster;
  /** Bolt-backed SlackReactor for HTTP route injection. */
  getReactor(): SlackReactor;
  /**
   * Workspace URL captured from auth.test (e.g. `https://priori-labs.slack.com/`).
   * Returns `null` if start() hasn't completed yet or auth.test failed; callers
   * should fall back to `https://slack.com/` in that case.
   */
  getWorkspaceUrl(): string | null;
  /**
   * Real Socket Mode connection status, driven by the SocketModeClient
   * lifecycle events (not a set-once startup flag). Consumed by the `/health`
   * route and the daemon's connection watchdog so a wedged socket is visible
   * and actionable instead of silently deaf.
   */
  getConnectionStatus(): ConnectionStatus;
}

export interface SlackAppDeps {
  askRegistry: AskRegistry;
  registry: DurableRegistry;
  heartbeatManager: HeartbeatManager;
  /**
   * Serializes spawn-and-post turns for daemon-spawned attachments (the
   * @-mention durable path). Required: every reply to a daemon-worker
   * attachment kicks this; without it those messages would sit unprocessed.
   */
  daemonWorker: DaemonWorker;
}

export function createSlackApp(
  config: Config,
  deps: SlackAppDeps,
): SlackAppHandle {
  // Own the SocketModeReceiver explicitly (instead of `socketMode: true`, which
  // makes Bolt construct one internally and hide it) so we hold a direct
  // reference to the underlying SocketModeClient. That reference is what lets us
  // observe the real connection lifecycle and expose it honestly.
  const socketReceiver = new SocketModeReceiver({
    appToken: config.slackAppToken,
  });
  const app = new App({
    token: config.slackBotToken,
    receiver: socketReceiver,
  });

  // Real socket connection state, driven by SocketModeClient lifecycle events.
  // `socketConnected` is true only while Slack's `hello` handshake is live: the
  // client emits 'connected' on hello and 'connecting'/'reconnecting'/
  // 'disconnecting'/'disconnected' as it leaves that state. `lastConnectedAt`
  // anchors the watchdog's down-time measurement so the client's repeated
  // 'reconnecting' emissions can't reset the clock and hide a stuck loop.
  const startedAt = Date.now();
  let socketConnected = false;
  let lastConnectedAt: number | null = null;
  let stopping = false;

  const socketClient = socketReceiver.client;
  socketClient.on('connected', () => {
    socketConnected = true;
    lastConnectedAt = Date.now();
    console.log(
      '[agent-comms] Socket Mode connection established (hello received)',
    );
  });
  for (const phase of [
    'connecting',
    'reconnecting',
    'disconnecting',
    'disconnected',
  ] as const) {
    socketClient.on(phase, () => {
      if (socketConnected && !stopping) {
        console.warn(
          `[agent-comms] Socket Mode left connected state → ${phase}`,
        );
      }
      socketConnected = false;
    });
  }

  let selfBotUserId: string | undefined;
  // Captured from auth.test() during start(); shape: 'https://<workspace>.slack.com/'.
  // Used to build workspace-scoped permalinks so generated thread URLs deep-link
  // in the user's Slack client (the generic slack.com/archives/... URLs sometimes
  // fail to resolve to the right workspace).
  let workspaceUrl: string | null = null;

  app.event('message', async ({ event, client, logger }) => {
    // Bolt's payload union is wide; narrow on the fields we use.
    const ev = event as {
      channel?: string;
      thread_ts?: string;
      ts?: string;
      user?: string;
      text?: string;
      subtype?: string;
      bot_id?: string;
    };

    if (ev.channel !== config.slackAgentCommsChannel) return;
    if (!ev.thread_ts) return; // parent messages — ignore
    if (ev.subtype === 'bot_message') return;
    if (ev.bot_id) return; // any bot, including our own
    if (!ev.user || !ev.text || !ev.ts) return;

    if (!config.slackAllowedUsers.has(ev.user)) {
      logger.warn(
        `[agent-comms] message from non-allowlisted user=${ev.user} in thread=${ev.thread_ts} — reacting with 🚫 and ignoring`,
      );
      try {
        await client.reactions.add({
          channel: ev.channel,
          timestamp: ev.ts,
          name: 'no_entry_sign',
        });
      } catch (err) {
        logger.warn(
          `[agent-comms] could not react to non-allowlisted message: ${(err as Error).message}`,
        );
      }
      return;
    }

    await routeThreadReply({
      threadTs: ev.thread_ts,
      channel: ev.channel,
      ts: ev.ts,
      text: ev.text,
      userId: ev.user,
      selfBotUserId,
      poster: createBoltPoster(client),
      registry: deps.registry,
      durableRegistry: deps.registry,
      askRegistry: deps.askRegistry,
      reactor: createBoltReactor(client),
      heartbeatManager: deps.heartbeatManager,
      daemonWorker: deps.daemonWorker,
    });
  });

  app.event('app_mention', async ({ event, client, logger }) => {
    const ev = event as {
      channel?: string;
      thread_ts?: string;
      ts?: string;
      user?: string;
      text?: string;
    };

    if (ev.channel !== config.slackAgentCommsChannel) return;
    if (ev.thread_ts) return; // in-thread mention — message handler routes via registry
    if (!ev.user || !ev.text || !ev.ts) return;

    if (!config.slackAllowedUsers.has(ev.user)) {
      logger.warn(
        `[agent-comms] @mention from non-allowlisted user=${ev.user} — reacting 🚫 and ignoring`,
      );
      try {
        await client.reactions.add({
          channel: ev.channel,
          timestamp: ev.ts,
          name: 'no_entry_sign',
        });
      } catch (err) {
        logger.warn(
          `[agent-comms] could not react to non-allowlisted mention: ${(err as Error).message}`,
        );
      }
      return;
    }

    const { handleHarnessMention, mentionHelpText, parseMentionCommand } =
      await import('./handler');

    const userText = stripMentionPrefix(ev.text);
    const parsed = parseMentionCommand(userText);
    const mention = selfBotUserId ? `<@${selfBotUserId}>` : '@app';
    if (!parsed) {
      await client.chat.postMessage({
        channel: ev.channel,
        thread_ts: ev.ts,
        text: mentionHelpText(mention),
      });
      return;
    }

    await handleHarnessMention({
      mentionTs: ev.ts,
      channel: ev.channel,
      harness: parsed.harness,
      cwd: config.defaultMentionCwd,
      machineId: config.machineId,
      registry: deps.registry,
      poster: createBoltPoster(client),
    });
  });

  const boltPosterGlobal = createBoltPoster(app.client);
  const boltReactorGlobal = createBoltReactor(app.client);

  return {
    async start() {
      await app.start();
      // socketConnected is set by the 'connected' lifecycle event (fired on
      // Slack's `hello`), which lands before app.start() resolves. We rely on
      // that event as the source of truth rather than assuming here.
      try {
        const auth = await app.client.auth.test();
        selfBotUserId = auth.user_id;
        if (typeof auth.url === 'string' && auth.url.length > 0) {
          workspaceUrl = auth.url.endsWith('/') ? auth.url : `${auth.url}/`;
        }
        if (selfBotUserId) {
          console.log(
            `[agent-comms] Slack connected as user_id=${selfBotUserId} workspace=${workspaceUrl ?? '(unknown)'}`,
          );
        }
      } catch (err) {
        console.warn(
          `[agent-comms] auth.test failed (Slack still connected): ${(err as Error).message}`,
        );
      }
    },
    async stop() {
      stopping = true;
      try {
        await app.stop();
      } finally {
        socketConnected = false;
      }
    },
    isConnected() {
      return socketConnected;
    },
    async postOpener({ channel, text }) {
      const res = await app.client.chat.postMessage({ channel, text });
      if (!res.ts) throw new Error('chat.postMessage returned no ts');
      return { ts: res.ts };
    },
    async postThreadMessage({ channel, threadTs, text }) {
      const res = await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      });
      if (!res.ts) throw new Error('chat.postMessage returned no ts');
      return { ts: res.ts };
    },
    getPoster() {
      return boltPosterGlobal;
    },
    getReactor() {
      return boltReactorGlobal;
    },
    getWorkspaceUrl() {
      return workspaceUrl;
    },
    getConnectionStatus() {
      return { connected: socketConnected, lastConnectedAt, startedAt };
    },
  };
}
