/**
 * Shared attached-thread primitive used by /attach and /post routes.
 *
 * Resolution precedence (matches /ask's Phase 3 guard):
 *   1. Durable attachment for this CC session (`attachments` table).
 *      `/slack-attach-session` writes one of these — `/post` MUST prefer
 *      it over the legacy handoff, otherwise every post creates a brand
 *      new thread that the routing logic dead-ends with the "previous
 *      version of agent-comms" notice on inbound replies.
 *   2. Legacy active handoff for this CC session (`handoffs` table).
 *      Pre-Phase-3 attach + v1 carry-over.
 *   3. Lazy-create a new handoff (AFK one-way notification mode).
 */

import type { DurableRegistry } from '../registry';
import type { SessionInfo } from '../session/discover';
import { discoverCurrentSession } from '../session/discover';
import type { SlackPoster } from '../slack/types';

export interface ThreadServiceDeps {
  channelId: string;
  machineId: string;
  registry: DurableRegistry;
  poster: SlackPoster;
  threadUrl: (channel: string, ts: string) => string;
  /** Injectable for tests — defaults to discoverCurrentSession. */
  discoverSession?: (cwd: string) => SessionInfo | null;
}

export type ResolveOrCreateResult =
  | {
      ok: true;
      threadTs: string;
      channelId: string;
      sessionId: string;
      threadUrl: string;
      created: boolean;
    }
  | { ok: false; error: string; code: 'no_session' | 'slack_post_failed' };

export async function resolveOrCreateThread(
  deps: ThreadServiceDeps,
  opts: { cwd: string; sessionId?: string; hint?: string },
): Promise<ResolveOrCreateResult> {
  const discover = deps.discoverSession ?? discoverCurrentSession;

  const sessionId = opts.sessionId ?? discover(opts.cwd)?.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: `No Claude Code session found for cwd: ${opts.cwd}. Pass --session-id <id> to override.`,
      code: 'no_session',
    };
  }

  // 1. Prefer durable attachment (Phase 3). Active OR stale so a
  //    briefly-unresponsive monitor doesn't fork the conversation into a
  //    fresh legacy handoff thread on every post.
  const attachment = deps.registry.findRoutableAttachmentBySessionId(sessionId);
  if (attachment) {
    return {
      ok: true,
      threadTs: attachment.thread_ts,
      channelId: attachment.channel_id,
      sessionId,
      threadUrl: deps.threadUrl(attachment.channel_id, attachment.thread_ts),
      created: false,
    };
  }

  // 2. Legacy active handoff (v1 / pre-Phase-3 carry-over).
  const existing = deps.registry.findActiveBySessionId(sessionId);
  if (existing) {
    return {
      ok: true,
      threadTs: existing.thread_ts,
      channelId: existing.channel_id,
      sessionId: existing.session_id,
      threadUrl: deps.threadUrl(existing.channel_id, existing.thread_ts),
      created: false,
    };
  }

  const shortId = sessionId.slice(0, 8);
  const hintLine = opts.hint ? `\n${opts.hint}` : '';
  const text = `🤖 \`[attached]\` *${deps.machineId}* | session \`${shortId}\` | cwd \`${opts.cwd}\`${hintLine}`;

  let posted: { ts: string };
  try {
    posted = await deps.poster.postOpener({ channel: deps.channelId, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Slack post failed: ${msg}`,
      code: 'slack_post_failed',
    };
  }

  deps.registry.insertHandoff({
    thread_ts: posted.ts,
    channel_id: deps.channelId,
    session_id: sessionId,
    cwd: opts.cwd,
    machine_id: deps.machineId,
    opened_at: Date.now(),
  });

  return {
    ok: true,
    threadTs: posted.ts,
    channelId: deps.channelId,
    sessionId,
    threadUrl: deps.threadUrl(deps.channelId, posted.ts),
    created: true,
  };
}

