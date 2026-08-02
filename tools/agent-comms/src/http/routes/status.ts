/**
 * POST /status — fire-and-forget agent status post to Slack.
 *
 * Posts a message to the attachment's Slack thread and records agent activity.
 * Not deduped: caller is responsible for rate-limiting status posts.
 *
 * Body: { attachment_id, text }
 * Response: { ok, slack_ts? }
 */

import { Hono } from 'hono';
import type { DurableRegistry } from '../../registry';
import type { SlackPoster } from '../../slack/types';

export interface StatusDeps {
  registry: DurableRegistry;
  poster: SlackPoster;
}

interface StatusBody {
  attachment_id?: string;
  text?: string;
}

export function statusRoute(deps: StatusDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: StatusBody;
    try {
      body = await c.req.json<StatusBody>();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.attachment_id)
      return c.json({ ok: false, error: 'attachment_id required' }, 400);
    if (!body.text?.trim())
      return c.json(
        { ok: false, error: 'text required and must be non-empty' },
        400,
      );

    const attachment = deps.registry.getAttachment(body.attachment_id);
    if (!attachment)
      return c.json({ ok: false, error: 'attachment not found' }, 404);

    const now = Date.now();

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
      return c.json({ ok: false, error: `Slack post failed: ${msg}` }, 502);
    }

    deps.registry.recordAgentActivity(body.attachment_id, now);

    return c.json({ ok: true, slack_ts: slackTs });
  });

  return route;
}

