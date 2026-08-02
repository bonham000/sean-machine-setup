/**
 * POST /attach-live — register or reuse a durable attachment.
 *
 * Called by `agent-comms monitor --attach-live` (or the /slack-attach-session
 * slash command) at the start of a terminal-attached CC session. Creates an
 * attachment row in the durable registry and posts a Slack opener if this is
 * a new thread. Idempotent: if an active attachment already exists for the
 * same (channel, thread_ts) it is returned as-is.
 *
 * Body: { cwd, session_id?, hint?, channel_id?, thread_ts?, owner_mode? }
 * Response: { ok, attachment_id, status, thread_ts, thread_url, created }
 */

import { Hono } from 'hono';
import type { DurableRegistry } from '../../registry';
import type { SessionInfo } from '../../session/discover';
import { discoverCurrentSession } from '../../session/discover';
import type { SlackPoster } from '../../slack/types';

export interface AttachLiveDeps {
  registry: DurableRegistry;
  channelId: string;
  machineId: string;
  poster: SlackPoster;
  threadUrl: (channel: string, ts: string) => string;
  /**
   * Injectable session discovery. When the slash command (or other caller)
   * does not provide an explicit `session_id`, attach-live discovers it from
   * `cwd` so the attachment row has a populated session_id. This is what
   * lets `/ask`'s session-id-based precedence guard reject ask in attached
   * sessions reliably — without server-side discovery, attach-live stored
   * session_id = null and the guard silently no-op'd.
   */
  discoverSession?: (cwd: string) => SessionInfo | null;
}

interface AttachLiveBody {
  cwd?: string;
  session_id?: string;
  hint?: string;
  channel_id?: string;
  thread_ts?: string;
  owner_mode?: 'terminal-attached' | 'daemon-spawned';
  /**
   * PID of the parent Claude Code session process. The slash command captures
   * $PPID of its bash subshell, which IS the CC process. Used by the
   * heartbeat to distinguish hard-dead from soft-stale conditions.
   */
  cc_pid?: number;
}

export function attachLiveRoute(deps: AttachLiveDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: AttachLiveBody;
    try {
      body = await c.req.json<AttachLiveBody>();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.cwd) {
      return c.json({ ok: false, error: 'cwd required' }, 400);
    }

    const channelId = body.channel_id ?? deps.channelId;
    const ownerMode = body.owner_mode ?? 'terminal-attached';

    // Resolve session_id: caller-supplied wins; else discover from cwd. The
    // slash command (templates/.../slack-attach-session.md) does NOT send
    // session_id, so server-side discovery is what makes the resulting
    // attachment row have a populated session_id. This is required by
    // /ask's precedence guard — without it, ask cannot detect the attached
    // session and could lazy-create a parallel legacy thread.
    const discover = deps.discoverSession ?? discoverCurrentSession;
    const sessionId = body.session_id ?? discover(body.cwd)?.sessionId ?? null;

    // If caller supplies a specific thread_ts, use that existing thread.
    // Otherwise post a new opener to Slack and use the returned ts.
    let threadTs: string;
    let created: boolean;

    if (body.thread_ts) {
      threadTs = body.thread_ts;
      created = false;
    } else {
      const shortId = (sessionId ?? body.cwd).slice(0, 8);
      const hintLine = body.hint ? `\n${body.hint}` : '';
      const text = `🤖 \`[attached]\` *${deps.machineId}* | session \`${shortId}\` | cwd \`${body.cwd}\`${hintLine}`;

      let posted: { ts: string };
      try {
        posted = await deps.poster.postOpener({ channel: channelId, text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, error: `Slack post failed: ${msg}` }, 502);
      }
      threadTs = posted.ts;
      created = true;
    }

    const attachment = deps.registry.createOrReuseAttachment({
      channelId,
      threadTs,
      sessionId,
      cwd: body.cwd,
      machineId: deps.machineId,
      ownerMode,
      ccPid: typeof body.cc_pid === 'number' ? body.cc_pid : null,
    });

    // If createOrReuseAttachment returned an existing row, created is false.
    if (!created && attachment.created_at === attachment.updated_at) {
      // New row was just inserted — leave created=true if we posted a new opener,
      // but if thread_ts was supplied and the row already existed, mark not-created.
    }

    return c.json({
      ok: true,
      attachment_id: attachment.id,
      status: attachment.status,
      thread_ts: attachment.thread_ts,
      thread_url: deps.threadUrl(channelId, attachment.thread_ts),
      created,
    });
  });

  return route;
}

