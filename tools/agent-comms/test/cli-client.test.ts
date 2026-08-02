import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchFn } from '../src/cli/client';
import { createClient } from '../src/cli/client';

const FAKE_SECRET = 'test-secret-value';

function makeFakeSecret(dir: string): string {
  const p = join(dir, 'secret');
  writeFileSync(p, FAKE_SECRET, { mode: 0o600 });
  return p;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createClient', () => {
  let tmpDir: string;
  let secretPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-client-test-'));
    secretPath = makeFakeSecret(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy post — returns thread_url and created flag', async () => {
    const fakeFetch: FetchFn = async () =>
      jsonResp({ ok: true, thread_url: 'https://slack.com/t', created: false });
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.post({ cwd: '/tmp', text: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.thread_url).toBe('https://slack.com/t');
      expect(result.created).toBe(false);
    }
  });

  it('happy ask — returns reply text', async () => {
    const fakeFetch: FetchFn = async () =>
      jsonResp({
        ok: true,
        reply: 'the user says hi',
        thread_url: 'https://slack.com/t',
      });
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.ask({ cwd: '/tmp', text: 'Q?' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect((result as { reply: string }).reply).toBe('the user says hi');
  });

  it('408 timed_out — returns ok=false, status 408', async () => {
    const fakeFetch: FetchFn = async () =>
      jsonResp({ ok: false, error: 'timed_out' }, 408);
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.ask({ cwd: '/tmp', text: 'Q?' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(408);
      expect(result.error).toBe('timed_out');
    }
  });

  it('503 daemon_shutdown — returns ok=false, status 503', async () => {
    const fakeFetch: FetchFn = async () =>
      jsonResp({ ok: false, error: 'daemon_shutdown' }, 503);
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.ask({ cwd: '/tmp', text: 'Q?' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toBe('daemon_shutdown');
    }
  });

  it('connection refused (ECONNREFUSED) — returns ok=false, status -1', async () => {
    const fakeFetch: FetchFn = async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:42100');
    };
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.post({ cwd: '/tmp', text: 'hello' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(-1);
      expect(result.error).toContain('Connection refused');
    }
  });

  it('missing secret — throws with helpful message', async () => {
    const fakeFetch: FetchFn = async () => new Response('');
    const client = createClient({
      secretPath: '/no/such/secret',
      port: 42100,
      fetch: fakeFetch,
    });
    await expect(client.post({ cwd: '/tmp', text: 'hi' })).rejects.toThrow(
      'Secret file not found',
    );
  });

  it('non-JSON daemon response — returns ok=false with error message', async () => {
    const fakeFetch: FetchFn = async () =>
      new Response('not json', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.post({ cwd: '/tmp', text: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Non-JSON');
  });

  it('passes X-Agent-Comms-Secret header', async () => {
    let capturedHeader: string | undefined;
    const fakeFetch: FetchFn = async (_url, init) => {
      capturedHeader = (init?.headers as Record<string, string>)?.[
        'X-Agent-Comms-Secret'
      ];
      return jsonResp({ ok: true, thread_url: 'https://t', created: true });
    };
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    await client.post({ cwd: '/tmp', text: 'hi' });
    expect(capturedHeader).toBe(FAKE_SECRET);
  });

  it('getMessage — GETs /messages/<id> and returns the row verbatim', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const fakeFetch: FetchFn = async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method;
      return jsonResp({
        ok: true,
        message: {
          id: 'msg_abc',
          attachment_id: 'att_1',
          direction: 'slack_to_agent',
          slack_ts: '111.222',
          sender_id: 'U_SEAN',
          text: 'the full body, exactly as sent',
          requires_response: 1,
          status: 'leased',
          lease_holder: 'tok',
          lease_expires_at: 0,
          error: null,
          created_at: 1,
          emitted_at: null,
          handled_at: null,
        },
      });
    };
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.getMessage('msg_abc');
    expect(capturedMethod).toBe('GET');
    expect(capturedUrl).toContain('/messages/msg_abc');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.text).toBe('the full body, exactly as sent');
      expect(result.message.id).toBe('msg_abc');
    }
  });

  it('getMessage — url-encodes ids with special characters', async () => {
    let capturedUrl: string | undefined;
    const fakeFetch: FetchFn = async (url) => {
      capturedUrl = String(url);
      return jsonResp({ ok: false, error: 'message not found' }, 404);
    };
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    await client.getMessage('weird/id with spaces');
    expect(capturedUrl).toContain('/messages/weird%2Fid%20with%20spaces');
  });

  it('getMessage — 404 surfaces as ok:false with status 404', async () => {
    const fakeFetch: FetchFn = async () =>
      jsonResp({ ok: false, error: 'message not found' }, 404);
    const client = createClient({ secretPath, port: 42100, fetch: fakeFetch });
    const result = await client.getMessage('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toContain('not found');
    }
  });
});

