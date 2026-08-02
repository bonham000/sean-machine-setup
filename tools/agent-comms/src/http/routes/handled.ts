/**
 * POST /handled — close a pending response without a Slack reply.
 *
 * Marks an inbound message handled without posting to Slack. Idempotent on
 * (attachment_id, message_id): a duplicate call returns the prior result.
 *
 * Body: { attachment_id, message_id }
 * Response: { ok, already_handled? }
 */

import { Hono } from 'hono';
import type { DurableRegistry } from '../../registry';
import type { HeartbeatManager } from '../../slack/heartbeat';

export interface HandledDeps {
  registry: DurableRegistry;
  /** Heartbeat manager — stop(messageId) is called immediately on handled. */
  heartbeatManager?: HeartbeatManager;
}

interface HandledBody {
  attachment_id?: string;
  message_id?: string;
}

export function handledRoute(deps: HandledDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: HandledBody;
    try {
      body = await c.req.json<HandledBody>();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.attachment_id)
      return c.json({ ok: false, error: 'attachment_id required' }, 400);
    if (!body.message_id)
      return c.json({ ok: false, error: 'message_id required' }, 400);

    // Verify the attachment exists (FK would catch the message, but give a clear error)
    const attachment = deps.registry.getAttachment(body.attachment_id);
    if (!attachment)
      return c.json({ ok: false, error: 'attachment not found' }, 404);

    const now = Date.now();
    const transitioned = deps.registry.markMessageHandled({
      attachmentId: body.attachment_id,
      messageId: body.message_id,
      now,
    });

    if (!transitioned) {
      // Disambiguate already-handled vs cross-attachment mismatch.
      const msg = deps.registry.getMessageById(body.message_id);
      if (!msg || msg.attachment_id !== body.attachment_id) {
        return c.json(
          { ok: false, error: 'message_id does not belong to attachment_id' },
          404,
        );
      }
      return c.json({ ok: true, already_handled: true });
    }

    deps.registry.recordAgentActivity(body.attachment_id, now);

    // Stop the heartbeat immediately so no stale posts fire after handled.
    deps.heartbeatManager?.stop(body.message_id);

    return c.json({ ok: true });
  });

  return route;
}

