import { describe, expect, it } from 'bun:test';
import { restartAfterReplyRoute } from '../src/http/routes/restart-after-reply';

describe('POST /restart-after-reply', () => {
  it('queues idempotently', async () => {
    let requests = 0;
    const route = restartAfterReplyRoute({
      requestRestartAfterReply: () => ({ alreadyQueued: requests++ > 0 }),
    });

    const first = await route.request('/', { method: 'POST' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, status: 'queued' });

    const second = await route.request('/', { method: 'POST' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      status: 'already_queued',
    });
  });

  it('fails closed when restart control is not wired', async () => {
    const route = restartAfterReplyRoute({});
    const response = await route.request('/', { method: 'POST' });
    expect(response.status).toBe(503);
  });
});
