import { Hono } from 'hono';
import type { ThreadServiceDeps } from '../thread-service';
import { resolveOrCreateThread } from '../thread-service';

export type PostDeps = ThreadServiceDeps;

interface PostBody {
  cwd?: string;
  text?: string;
  session_id?: string;
}

export function postRoute(deps: PostDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: PostBody;
    try {
      body = await c.req.json<PostBody>();
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    if (!body.cwd) {
      return c.json({ ok: false, error: 'cwd required' }, 400);
    }
    if (!body.text?.trim()) {
      return c.json(
        { ok: false, error: 'text required and must be non-empty' },
        400,
      );
    }

    const resolved = await resolveOrCreateThread(deps, {
      cwd: body.cwd,
      sessionId: body.session_id,
    });

    if (!resolved.ok) {
      const status = resolved.code === 'no_session' ? 404 : 502;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    try {
      await deps.poster.postThreadMessage({
        channel: resolved.channelId,
        threadTs: resolved.threadTs,
        text: body.text,
      });
    } catch (err) {
      // Registry row is kept even if postThreadMessage fails after lazy-create,
      // because the Slack thread now exists and can be reused.
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: `Slack post failed: ${msg}` }, 502);
    }

    return c.json({
      ok: true,
      thread_url: resolved.threadUrl,
      created: resolved.created,
    });
  });

  return route;
}

