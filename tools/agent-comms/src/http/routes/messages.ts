/**
 * GET /messages/:id — fetch a single message row by id.
 *
 * Companion to the `monitor` long-poll surface. The Monitor tool in Claude
 * Code applies a small per-event stdout cap that truncates lines with a
 * literal `...(truncated)` suffix, so we no longer pack the message body
 * into the monitor's stdout line: monitor emits notification metadata
 * only and CC fetches the full body via this route over Bash (whose
 * output cap is much larger than Monitor's per-event cap).
 *
 * Auth: shared X-Agent-Comms-Secret (enforced by parent route group).
 * Response:
 *   200 { ok: true, message: MessageRow }
 *   404 { ok: false, error: 'message not found' }
 */

import { Hono } from 'hono';
import type { DurableRegistry } from '../../registry';

export interface MessagesDeps {
  registry: DurableRegistry;
}

export function messagesRoute(deps: MessagesDeps): Hono {
  const route = new Hono();

  route.get('/:id', (c) => {
    const id = c.req.param('id');
    if (!id || id.length === 0) {
      return c.json({ ok: false, error: 'message id required' }, 400);
    }
    const message = deps.registry.getMessageById(id);
    if (!message) {
      return c.json({ ok: false, error: 'message not found' }, 404);
    }
    return c.json({ ok: true, message });
  });

  return route;
}

