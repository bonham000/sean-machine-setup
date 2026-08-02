import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeadlessHarnessId } from '../src/headless/harness';
import type { DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import {
  handleHarnessMention,
  mentionHelpText,
  parseMentionCommand,
} from '../src/slack/handler';
import { makePoster } from './fakes/slack';

describe('strict @app harness command', () => {
  it.each([
    'claude',
    'codex',
    'pi',
  ] as const)('accepts only the canonical %s identifier', (harness) => {
    expect(parseMentionCommand(harness)).toEqual({ harness });
    expect(parseMentionCommand(harness.toUpperCase())).toEqual({ harness });
  });

  it.each([
    '',
    'gemini',
    'claude do work',
    'claude-code',
    'codex:',
  ])('rejects invalid mention text %p', (text) =>
    expect(parseMentionCommand(text)).toBeNull());

  it('lists every valid identifier and asks the user to try again', () => {
    const text = mentionHelpText('<@UBOT>');
    expect(text).toContain('`claude`');
    expect(text).toContain('`codex`');
    expect(text).toContain('`pi`');
    expect(text).toContain('Try again');
    expect(text).toContain('<@UBOT> `codex`');
  });
});

describe('handleHarnessMention', () => {
  let dir: string;
  let registry: DurableRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mention-handler-'));
    registry = createDurableRegistry({ dbPath: join(dir, 'registry.db') });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function handle(
    harness: HeadlessHarnessId,
    preflight = mock(async () => {}),
  ) {
    const { poster, posts } = makePoster();
    await handleHarnessMention({
      mentionTs: '100.001',
      channel: 'C_AGENT',
      harness,
      cwd: '/repo',
      machineId: 'mac-mini',
      registry,
      poster,
      preflight,
    });
    return { posts, preflight };
  }

  it.each([
    'claude',
    'codex',
    'pi',
  ] as const)('preflights and registers %s before posting readiness', async (harness) => {
    const { posts, preflight } = await handle(harness);
    expect(preflight).toHaveBeenCalledWith(harness, '/repo');
    const attachment = registry.findRoutableAttachmentByChannelThread(
      'C_AGENT',
      '100.001',
    );
    expect(attachment?.agent_runtime).toBe(harness);
    expect(attachment?.session_id).toBeNull();
    expect(attachment?.delivery_adapter).toBe('daemon-worker');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe(
      `${harness === 'claude' ? 'Claude Code' : harness === 'codex' ? 'Codex' : 'Pi'} ready, reply to start.`,
    );
  });

  it('posts a visible preflight failure and does not register a binding', async () => {
    const preflight = mock(async () => {
      throw new Error('command missing');
    });
    const { posts } = await handle('codex', preflight);
    expect(
      registry.findRoutableAttachmentByChannelThread('C_AGENT', '100.001'),
    ).toBeNull();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain('Codex is not ready');
    expect(posts[0]!.text).toContain('command missing');
  });
});

