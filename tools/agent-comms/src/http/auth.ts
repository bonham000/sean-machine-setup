import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ensureSecret } from '../secret';

export const agentCommsSecretAuth: MiddlewareHandler = async (c, next) => {
  const provided = (c.req.header('X-Agent-Comms-Secret') ?? '').trim();
  if (!provided) {
    return c.json({ ok: false, error: 'Missing X-Agent-Comms-Secret' }, 401);
  }

  const expected = ensureSecret();

  // timingSafeEqual requires equal-length buffers; bail if obvious mismatch
  if (provided.length !== expected.length) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }
  const ok = timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );
  if (!ok) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }

  await next();
};

