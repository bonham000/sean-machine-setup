/**
 * Integration tests for GET /messages/:id — body-fetch companion to /monitor.
 *
 * The monitor stream emits notification-only lines so they fit under CC's
 * per-event Monitor stdout cap. CC reads the full body via this route over
 * Bash, which has a much larger output cap. The route must:
 *   - require the shared secret (covered by parent route-group auth)
 *   - return the full row verbatim for valid ids
 *   - 404 for unknown ids
 *   - 400 when no id is supplied (just /messages with nothing else routes
 *     somewhere else, but /messages/ on Hono won't reach this handler)
 *
 * Uses a real in-process Hono app + real SQLite DurableRegistry in a temp
 * dir, matching the http-monitor.test.ts harness style.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp } from '../src/http/server';
import {
  createDurableRegistry,
  type DurableRegistry,
  type MessageRow,
} from '../src/registry';
import { ensureSecret } from '../src/secret';
import { makeServerDeps } from './fakes/deps';
import { createFakeSlackClient } from './fakes/slack';

const CHANNEL = 'C_MESSAGES';
const MACHINE = 'test-machine';

let tmpHome: string;
let originalHome: string | undefined;
let SECRET: string;

async function getMessage(
  app: ReturnType<typeof createHttpApp>,
  id: string,
  headers: Record<string, string> = { 'X-Agent-Comms-Secret': SECRET },
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/messages/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers,
    }),
  );
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'http-messages-home-'));
  process.env.HOME = tmpHome;
  SECRET = ensureSecret();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /messages/:id', () => {
  let tmpDir: string;
  let registry: DurableRegistry;
  let app: ReturnType<typeof createHttpApp>;
  let attachmentId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'http-messages-test-'));
    registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
    const fake = createFakeSlackClient();
    app = createHttpApp(makeServerDeps(registry, fake, { channelId: CHANNEL }));

    const attachment = registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: '1710000000.000000',
      sessionId: 'sess-messages-test',
      cwd: '/tmp',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
    });
    attachmentId = attachment.id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the full row verbatim for a known id', async () => {
    const longText = `Oh btw I forgot to mention idk if this is in the plan or not, since we are redoing dialog content, once you're ready you should use our new reconciliation tooling to regenerate TTS for all these dialogs as a final validation so those static checks for content/TTS validation can pass. You are good to run those generation steps when you reach that point as part of this workstream.`;
    const inserted = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '1710000001.000001',
      senderId: 'U_SEAN',
      text: longText,
      requiresResponse: true,
    });
    expect(inserted.text.length).toBeGreaterThan(350);

    const resp = await getMessage(app, inserted.id);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; message: MessageRow };
    expect(body.ok).toBe(true);
    // Body must be verbatim — no truncation, no transformation.
    expect(body.message.id).toBe(inserted.id);
    expect(body.message.text).toBe(longText);
    expect(body.message.text.length).toBe(longText.length);
    expect(body.message.attachment_id).toBe(attachmentId);
    expect(body.message.sender_id).toBe('U_SEAN');
    expect(body.message.slack_ts).toBe('1710000001.000001');
  });

  it('returns 404 for an unknown id', async () => {
    const resp = await getMessage(app, 'no-such-message-id');
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not found');
  });

  it('requires the shared secret', async () => {
    const inserted = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '1710000002.000002',
      senderId: 'U_SEAN',
      text: 'hi',
      requiresResponse: false,
    });
    const resp = await getMessage(app, inserted.id, {});
    expect(resp.status).toBe(401);
  });

  it('preserves messages with embedded newlines and unicode verbatim', async () => {
    const trickyText =
      'line one\nline two — with em-dash 😀\n\nblank line above';
    const inserted = registry.insertInboundMessage({
      attachmentId,
      direction: 'slack_to_agent',
      slackTs: '1710000003.000003',
      senderId: 'U_SEAN',
      text: trickyText,
      requiresResponse: false,
    });

    const resp = await getMessage(app, inserted.id);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; message: MessageRow };
    expect(body.message.text).toBe(trickyText);
  });
});

