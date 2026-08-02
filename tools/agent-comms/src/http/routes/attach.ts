import { Hono } from 'hono';
import type { ThreadServiceDeps } from '../thread-service';
import { resolveOrCreateThread } from '../thread-service';

export type AttachDeps = ThreadServiceDeps;

interface AttachBody {
  cwd?: string;
  hint?: string;
  session_id?: string;
}

export function attachRoute(deps: AttachDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: AttachBody;
    try {
      body = await c.req.json<AttachBody>();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.cwd) {
      return c.json({ ok: false, error: 'cwd required' }, 400);
    }

    const result = await resolveOrCreateThread(deps, {
      cwd: body.cwd,
      sessionId: body.session_id,
      hint: body.hint,
    });

    if (!result.ok) {
      const status = result.code === 'no_session' ? 404 : 502;
      return c.json({ ok: false, error: result.error }, status);
    }

    return c.json({
      ok: true,
      status: result.created ? 'created' : 'already-active',
      thread_ts: result.threadTs,
      thread_url: result.threadUrl,
      session_id: result.sessionId,
    });
  });

  return route;
}

