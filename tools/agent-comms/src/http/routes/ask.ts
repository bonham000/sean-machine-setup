/**
 * POST /ask — blocking CC ask.
 *
 * Posts a question to the attached Slack thread and holds the HTTP connection
 * open until the user replies (or the timeout fires / daemon shuts down / client
 * aborts). The reply text is returned as `{ ok: true, reply }`.
 *
 * Phase 3 precedence guard: if the session already has an active durable
 * attachment, /ask is rejected with a 409 and a clear instruction to use
 * `agent-comms reply` / `agent-comms status` instead. The pending-ask registry
 * is consulted ONLY for non-attached threads. **The durable check runs BEFORE
 * resolveOrCreateThread** so an attached session that has no legacy handoff
 * row can't accidentally trigger a fresh legacy thread + Slack opener post.
 *
 * Order of operations:
 *   1. Validate body.
 *   2. Resolve session id (from body or discover) WITHOUT lazy-create.
 *   3. Check for active durable attachment by session — reject 409 if found.
 *      No Slack post, no legacy handoff insert.
 *   4. Resolve / lazy-create the attached legacy thread.
 *   5. Reserve the ask BEFORE posting to Slack so a fast reply cannot race.
 *   6. Post the question; cancel reservation on Slack failure.
 *   7. Listen for client abort; cancel reservation if it fires first.
 *   8. Await the reservation promise → respond.
 */

import { Hono } from 'hono';
import type { AskRegistry } from '../../asks';
import type { DurableRegistry } from '../../registry';
import { discoverCurrentSession } from '../../session/discover';
import type { ThreadServiceDeps } from '../thread-service';
import { resolveOrCreateThread } from '../thread-service';

export type AskDeps = ThreadServiceDeps & {
  askRegistry: AskRegistry;
  /**
   * Durable registry for the active-attachment precedence check.
   * When the caller's session has an active attachment, /ask is rejected so
   * the non-attached ask registry cannot intercept Slack replies for that thread.
   */
  durableRegistry?: DurableRegistry;
};

interface AskBody {
  cwd?: string;
  text?: string;
  timeout_seconds?: number;
  session_id?: string;
}

export function askRoute(deps: AskDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: AskBody;
    try {
      body = await c.req.json<AskBody>();
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

    const timeoutSeconds =
      body.timeout_seconds !== undefined ? body.timeout_seconds : 86400;
    const timeoutMs = timeoutSeconds === 0 ? 0 : timeoutSeconds * 1000;

    // Phase 3 precedence guard runs BEFORE resolveOrCreateThread so an
    // attached session without a legacy handoff row can't accidentally
    // trigger a fresh legacy thread + Slack opener.
    if (deps.durableRegistry) {
      const discover = deps.discoverSession ?? discoverCurrentSession;
      const sessionId =
        body.session_id ?? discover(body.cwd)?.sessionId ?? null;
      if (sessionId) {
        const activeAttachment =
          deps.durableRegistry.findActiveAttachmentBySessionId(sessionId);
        if (activeAttachment) {
          console.log(
            `[agent-comms] ask rejected: session=${sessionId.slice(0, 8)} has active attachment=${activeAttachment.id} — use reply/status instead`,
          );
          return c.json(
            {
              ok: false,
              error:
                'This session has an active durable attachment. Use `agent-comms reply` and `agent-comms status` instead of `agent-comms ask` — the next inbound Slack message will be delivered through the durable monitor. Run `agent-comms status` to post a message into the thread.',
            },
            409,
          );
        }
      }
    }

    // Resolve / lazy-create the attached thread
    const resolved = await resolveOrCreateThread(deps, {
      cwd: body.cwd,
      sessionId: body.session_id,
    });

    if (!resolved.ok) {
      const status = resolved.code === 'no_session' ? 404 : 502;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    const { threadTs, channelId, threadUrl } = resolved;

    // Reserve BEFORE posting so a fast user reply cannot miss the resolver
    const reserved = deps.askRegistry.reserve(threadTs, { timeoutMs });
    if (!reserved.ok) {
      return c.json(
        { ok: false, error: 'already_pending', thread_url: threadUrl },
        409,
      );
    }

    // Observe the reservation promise so early-return paths (Slack post failure,
    // already-aborted signal) don't leak an unhandled rejection. The success
    // path's `await reserved.promise` below still receives the resolve/reject.
    reserved.promise.catch(() => {});

    // Post the question to Slack
    try {
      await deps.poster.postThreadMessage({
        channel: channelId,
        threadTs,
        text: body.text,
      });
    } catch (err) {
      reserved.cancel('slack_post_failed');
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: `Slack post failed: ${msg}` }, 502);
    }

    // Handle client abort — cancel the reservation so it doesn't leak.
    // If the signal aborted between the Slack post and here, addEventListener
    // will not fire, so check `aborted` synchronously after attaching.
    const signal = c.req.raw.signal;
    const abortHandler = () => reserved.cancel('client_aborted');
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) reserved.cancel('client_aborted');

    try {
      const reply = await reserved.promise;
      return c.json({ ok: true, reply, thread_url: threadUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'timed_out') {
        return c.json(
          { ok: false, error: 'timed_out', thread_url: threadUrl },
          408,
        );
      }
      if (message === 'daemon_shutdown') {
        return c.json({ ok: false, error: 'daemon_shutdown' }, 503);
      }
      // client_aborted or other — client is gone, best-effort 500
      return c.json({ ok: false, error: message }, 500);
    } finally {
      signal?.removeEventListener('abort', abortHandler);
    }
  });

  return route;
}

