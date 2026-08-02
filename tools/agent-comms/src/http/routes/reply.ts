/**
 * POST /reply — idempotent egress reply.
 *
 * Posts a reply into the Slack thread and marks the inbound message handled.
 * Idempotent on (attachment_id, message_id): a duplicate call returns
 * `already_handled: true` without posting again.
 *
 * Order of operations (post-first, mark-on-success):
 *   1. Validate body + attachment exists.
 *   2. Pre-check the message: cross-attachment mismatch → 404; already
 *      handled → return cached success without posting.
 *   3. Post to Slack FIRST. If the post fails, do NOT transition the
 *      message — caller can retry. (Earlier "mark-then-post" order silently
 *      swallowed the user's reply when Slack returned 5xx.)
 *   4. On successful post, mark handled atomically. recordAgentActivity
 *      and heartbeat stop happen after.
 *
 * Concurrent-retry note: post-first means a malicious or buggy concurrent
 * caller (two CLIs hitting /reply for the same message in parallel) could
 * race past the pre-check and double-post. In practice the agent-comms CLI
 * is single-process per session and retries sequentially after a timeout,
 * so this is a known minor risk we accept to keep failed Slack posts
 * retryable. A future workstream could add a reply-attempt outbox to make
 * this fully atomic.
 *
 * Body: { attachment_id, message_id, text }
 * Response: { ok, already_handled?, slack_ts? }
 */

import { Hono } from 'hono';
import type { DurableRegistry } from '../../registry';
import type { HeartbeatManager } from '../../slack/heartbeat';
import type { SlackPoster } from '../../slack/types';

export interface ReplyDeps {
  registry: DurableRegistry;
  poster: SlackPoster;
  /** Heartbeat manager — stop(messageId) is called immediately on successful reply. */
  heartbeatManager?: HeartbeatManager;
}

interface ReplyBody {
  attachment_id?: string;
  message_id?: string;
  text?: string;
}

export function replyRoute(deps: ReplyDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: ReplyBody;
    try {
      body = await c.req.json<ReplyBody>();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.attachment_id)
      return c.json({ ok: false, error: 'attachment_id required' }, 400);
    if (!body.message_id)
      return c.json({ ok: false, error: 'message_id required' }, 400);
    if (!body.text?.trim())
      return c.json(
        { ok: false, error: 'text required and must be non-empty' },
        400,
      );

    const attachment = deps.registry.getAttachment(body.attachment_id);
    if (!attachment)
      return c.json({ ok: false, error: 'attachment not found' }, 404);

    // Pre-check: cross-attachment mismatch is always 404 (whether handled
    // or not). Already-handled (correct attachment) returns cached success
    // WITHOUT a re-post. This is the primary idempotency contract.
    const existing = deps.registry.getMessageById(body.message_id);
    if (!existing || existing.attachment_id !== body.attachment_id) {
      return c.json(
        { ok: false, error: 'message_id does not belong to attachment_id' },
        404,
      );
    }
    if (existing.status === 'handled') {
      return c.json({ ok: true, already_handled: true });
    }

    // Post the reply to Slack FIRST. If this fails the message stays in its
    // current state and the CLI can retry (post-first; mark-on-success).
    let slackTs: string | undefined;
    try {
      const result = await deps.poster.postThreadMessage({
        channel: attachment.channel_id,
        threadTs: attachment.thread_ts,
        text: body.text,
      });
      slackTs = result.ts;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[agent-comms] reply Slack post failed: attachment=${body.attachment_id} msg=${body.message_id} err=${msg}`,
      );
      return c.json({ ok: false, error: `Slack post failed: ${msg}` }, 502);
    }

    // Atomically mark handled now that the post succeeded. If a concurrent
    // call slipped past the pre-check and beat us to handled, the second
    // markMessageHandled returns false — we still report ok with our slack_ts.
    const now = Date.now();
    deps.registry.markMessageHandled({
      attachmentId: body.attachment_id,
      messageId: body.message_id,
      now,
    });
    deps.registry.recordAgentActivity(body.attachment_id, now);

    // Stop the heartbeat immediately so no stale "still working" posts fire
    // after the reply has been sent to Slack.
    deps.heartbeatManager?.stop(body.message_id);

    return c.json({ ok: true, slack_ts: slackTs });
  });

  return route;
}

