import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HeadlessHarnessTurnResult } from '../src/headless/harness';
import type { DurableRegistry } from '../src/registry';
import { createDurableRegistry } from '../src/registry';
import { createDaemonWorker } from '../src/slack/daemon-worker';
import type {
  HeadlessTurnRunner,
  RunHeadlessTurnArgs,
} from '../src/slack/headless-turn';
import { makePoster } from './fakes/slack';

function successfulResult(sessionId: string): HeadlessHarnessTurnResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    finalText: 'done',
    sessionId,
  };
}

describe('daemon worker harness ownership', () => {
  let dir: string;
  let registry: DurableRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-worker-'));
    registry = createDurableRegistry({ dbPath: join(dir, 'registry.db') });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serializes turns and resumes the selected harness after the first turn', async () => {
    const attachment = registry.createOrReuseAttachment({
      channelId: 'C_AGENT',
      threadTs: '100.001',
      cwd: '/repo',
      machineId: 'mac-mini',
      agentRuntime: 'codex',
      ownerMode: 'daemon-spawned',
      deliveryAdapter: 'daemon-worker',
    });
    const first = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '101.001',
      text: 'first prompt',
    });
    const second = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '102.001',
      text: 'second prompt',
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: RunHeadlessTurnArgs[] = [];
    const turnRunner: HeadlessTurnRunner = async (args) => {
      calls.push(args);
      if (calls.length === 1) await firstGate;
      return { result: successfulResult('codex-session'), thrown: null };
    };
    const worker = createDaemonWorker({
      registry,
      poster: makePoster().poster,
      turnRunner,
    });

    worker.kick({ attachmentId: attachment.id, messageId: first.id });
    worker.kick({ attachmentId: attachment.id, messageId: second.id });
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.harness).toBe('codex');
    expect(calls[0]!.sessionId).toBeUndefined();

    releaseFirst();
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sessionId).toBe('codex-session');
    expect(registry.getMessageById(first.id)?.status).toBe('handled');
    expect(registry.getMessageById(second.id)?.status).toBe('handled');
    expect(registry.getAttachment(attachment.id)?.session_id).toBe(
      'codex-session',
    );
  });

  it('keeps existing claude-code runtime rows resumable', async () => {
    const attachment = registry.createOrReuseAttachment({
      channelId: 'C_AGENT',
      threadTs: '100.001',
      cwd: '/repo',
      machineId: 'mac-mini',
      agentRuntime: 'claude-code',
      sessionId: 'claude-session',
      ownerMode: 'daemon-spawned',
      deliveryAdapter: 'daemon-worker',
    });
    const message = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '101.001',
      text: 'continue',
    });
    const calls: RunHeadlessTurnArgs[] = [];
    const worker = createDaemonWorker({
      registry,
      poster: makePoster().poster,
      turnRunner: async (args) => {
        calls.push(args);
        return { result: successfulResult('claude-session'), thrown: null };
      },
    });
    worker.kick({ attachmentId: attachment.id, messageId: message.id });
    await worker.drain();
    expect(calls[0]!.harness).toBe('claude');
    expect(calls[0]!.sessionId).toBe('claude-session');
  });

  it('marks a failed first turn and attachment errored', async () => {
    const attachment = registry.createOrReuseAttachment({
      channelId: 'C_AGENT',
      threadTs: '100.001',
      cwd: '/repo',
      machineId: 'mac-mini',
      agentRuntime: 'pi',
      ownerMode: 'daemon-spawned',
      deliveryAdapter: 'daemon-worker',
    });
    const message = registry.insertInboundMessage({
      attachmentId: attachment.id,
      direction: 'slack_to_agent',
      slackTs: '101.001',
      text: 'start',
    });
    const worker = createDaemonWorker({
      registry,
      poster: makePoster().poster,
      turnRunner: async () => ({
        result: null,
        thrown: new Error('auth failed'),
      }),
    });
    worker.kick({ attachmentId: attachment.id, messageId: message.id });
    await worker.drain();
    expect(registry.getMessageById(message.id)?.status).toBe('failed');
    expect(registry.getAttachment(attachment.id)?.status).toBe('errored');
  });
});

