/**
 * Shared-secret auth middleware tests.
 *
 * The legacy X-Handoff-Secret alias (kept for one migration cycle after the
 * slack-handoff-bot → slack-agent-comms rename) was retired in June 2026.
 * Only X-Agent-Comms-Secret is accepted now; a regression case below pins
 * that the legacy header no longer authenticates.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { agentCommsSecretAuth } from '../src/http/auth';
import { ensureSecret } from '../src/secret';

let originalHome: string | undefined;
let tmpHome: string;
let secret: string;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'agent-comms-auth-test-'));
  process.env.HOME = tmpHome;
  secret = ensureSecret();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', agentCommsSecretAuth);
  app.get('/ok', (c) => c.json({ ok: true }));
  return app;
}

describe('agentCommsSecretAuth', () => {
  test('accepts X-Agent-Comms-Secret (canonical)', async () => {
    const res = await buildApp().request('/ok', {
      headers: { 'X-Agent-Comms-Secret': secret },
    });
    expect(res.status).toBe(200);
  });

  test('rejects when the header is missing', async () => {
    const res = await buildApp().request('/ok');
    expect(res.status).toBe(401);
  });

  test('rejects when the value is wrong', async () => {
    const res = await buildApp().request('/ok', {
      headers: { 'X-Agent-Comms-Secret': 'wrong-secret-value' },
    });
    expect(res.status).toBe(401);
  });

  test('retired legacy X-Handoff-Secret alias no longer authenticates', async () => {
    const res = await buildApp().request('/ok', {
      headers: { 'X-Handoff-Secret': secret },
    });
    expect(res.status).toBe(401);
  });
});

