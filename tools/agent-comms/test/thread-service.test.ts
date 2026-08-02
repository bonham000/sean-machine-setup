import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadServiceDeps } from '../src/http/thread-service';
import { resolveOrCreateThread } from '../src/http/thread-service';
import type { DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import type { SlackPoster } from '../src/slack/types';
import { createFakeSlackClient } from './fakes/slack';

const CHANNEL = 'C_TEST';
const MACHINE = 'test-machine';

// Intentional variant of the shared fakes/deps makeThreadUrl: strips the dot
// from the ts (Slack permalink style) so assertions cover URL formatting.
function makeThreadUrl(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

describe('resolveOrCreateThread', () => {
  let tmpDir: string;
  let registry: DurableRegistry;
  let fake: ReturnType<typeof createFakeSlackClient>;
  let deps: ThreadServiceDeps;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'thread-service-test-'));
    registry = createDurableRegistry({ dbPath: join(tmpDir, 'registry.db') });
    fake = createFakeSlackClient();

    deps = {
      channelId: CHANNEL,
      machineId: MACHINE,
      registry,
      poster: fake,
      threadUrl: makeThreadUrl,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no_session error when session cannot be discovered and no session_id given', async () => {
    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/nonexistent/cwd' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('no_session');
      expect(result.error).toContain('--session-id');
    }
  });

  it('lazy-creates thread when no existing row; posts opener and inserts registry row', async () => {
    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/test/cwd', sessionId: 'sess-abc123' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(true);
    expect(result.sessionId).toBe('sess-abc123');
    expect(result.channelId).toBe(CHANNEL);
    expect(result.threadTs).toBe('1');
    expect(result.threadUrl).toBe(makeThreadUrl(CHANNEL, '1'));

    // Opener was posted with expected content
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.channel).toBe(CHANNEL);
    expect(fake.posted[0]!.text).toContain('[attached]');
    expect(fake.posted[0]!.text).toContain('sess-abc');

    // Registry row was inserted
    const row = registry.findActiveBySessionId('sess-abc123');
    expect(row).not.toBeNull();
    expect(row!.thread_ts).toBe('1');
  });

  it('reuses existing active thread without posting a new opener', async () => {
    // Pre-insert a row
    registry.insertHandoff({
      thread_ts: 'existing-ts',
      channel_id: CHANNEL,
      session_id: 'sess-existing',
      cwd: '/test/cwd',
      machine_id: MACHINE,
      opened_at: Date.now(),
    });

    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/test/cwd', sessionId: 'sess-existing' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.threadTs).toBe('existing-ts');

    // No new opener posted
    expect(fake.posted).toHaveLength(0);
  });

  it('explicit session_id bypasses discoverSession', async () => {
    // discoverSession always returns null, but session_id is provided
    const neverCalled = (): ReturnType<
      NonNullable<ThreadServiceDeps['discoverSession']>
    > => {
      throw new Error('discoverSession should not be called');
    };

    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: neverCalled },
      { cwd: '/any', sessionId: 'explicit-sess' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe('explicit-sess');
  });

  it('includes hint in the opener text', async () => {
    await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/test', sessionId: 'sess-hint', hint: 'working on feature X' },
    );

    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.text).toContain('working on feature X');
  });

  it('returns slack_post_failed error when postOpener throws', async () => {
    const failingPoster: SlackPoster = {
      async postOpener() {
        throw new Error('Slack is down');
      },
      async postThreadMessage() {
        return { ts: '99' };
      },
    };

    const result = await resolveOrCreateThread(
      { ...deps, poster: failingPoster, discoverSession: () => null },
      { cwd: '/test', sessionId: 'sess-fail' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('slack_post_failed');
      expect(result.error).toContain('Slack is down');
    }

    // Registry row must NOT be inserted on Slack failure
    expect(registry.findActiveBySessionId('sess-fail')).toBeNull();
  });

  it('missing session_id with no discovery returns no_session', async () => {
    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/empty' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_session');
  });

  it('prefers durable attachment over legacy handoff and never posts a new opener', async () => {
    // Seed BOTH a durable attachment AND a legacy handoff for the same
    // session_id — exercises the precedence: attachment wins, no new
    // opener is posted, the existing thread is returned.
    registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: 'attached-ts',
      sessionId: 'sess-double',
      cwd: '/test/cwd',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
      ccPid: 12345,
    });
    registry.insertHandoff({
      thread_ts: 'legacy-ts',
      channel_id: CHANNEL,
      session_id: 'sess-double',
      cwd: '/test/cwd',
      machine_id: MACHINE,
      opened_at: Date.now(),
    });

    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/test/cwd', sessionId: 'sess-double' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.threadTs).toBe('attached-ts');
    // No new opener — must NOT lazy-create a fresh thread.
    expect(fake.posted).toHaveLength(0);
  });

  it('uses durable attachment even when it has gone stale', async () => {
    // The regression: a stale attachment used to fall through to the
    // legacy lazy-create path, splitting the conversation across two
    // threads. Now the routable lookup includes 'stale'.
    registry.createOrReuseAttachment({
      channelId: CHANNEL,
      threadTs: 'stale-ts',
      sessionId: 'sess-stale',
      cwd: '/test/cwd',
      machineId: MACHINE,
      ownerMode: 'terminal-attached',
      ccPid: 9876,
    });
    const found = registry.findActiveAttachmentBySessionId('sess-stale');
    expect(found).not.toBeNull();
    registry.markAttachmentStale(found!.id);

    const result = await resolveOrCreateThread(
      { ...deps, discoverSession: () => null },
      { cwd: '/test/cwd', sessionId: 'sess-stale' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.threadTs).toBe('stale-ts');
    expect(result.created).toBe(false);
    expect(fake.posted).toHaveLength(0);
  });
});

