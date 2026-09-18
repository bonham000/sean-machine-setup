import { describe, expect, it } from 'bun:test';
import type { HeadlessHarnessTurnResult } from '../src/headless/harness';
import { createHeadlessTurnRunner } from '../src/slack/headless-turn';
import { makePoster } from './fakes/slack';

function result(
  overrides: Partial<HeadlessHarnessTurnResult> = {},
): HeadlessHarnessTurnResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    finalText: '**Finished**',
    sessionId: 'session-1',
    failureDetail: null,
    ...overrides,
  };
}

const turnArgs = {
  threadTs: '100.001',
  channel: 'C_AGENT',
  harness: 'codex' as const,
  userText: 'Do the work',
  cwd: '/repo',
};

describe('Slack-facing headless turn', () => {
  it('posts a placeholder and Slack-formatted final response', async () => {
    const { poster, posts } = makePoster();
    const runner = createHeadlessTurnRunner(async (args) => {
      expect(args.prompt).toBe('Do the work');
      expect(args.systemPrompt).toContain(
        'daemon will post your final response',
      );
      return result();
    });

    const outcome = await runner({ ...turnArgs, poster });

    expect(outcome.result?.sessionId).toBe('session-1');
    expect(outcome.thrown).toBeNull();
    expect(posts.map((post) => post.text)).toEqual([
      '_thinking..._',
      '*Finished*',
    ]);
  });

  it('posts a visible process failure', async () => {
    const { poster, posts } = makePoster();
    const runner = createHeadlessTurnRunner(async () =>
      result({
        exitCode: 7,
        stderr: 'bad credentials',
        finalText: '',
        failureDetail: 'bad credentials',
      }),
    );

    const outcome = await runner({ ...turnArgs, poster });

    expect(outcome.result?.exitCode).toBe(7);
    expect(posts.at(-1)?.text).toContain('codex turn failed (exit 7)');
    expect(posts.at(-1)?.text).toContain('bad credentials');
  });

  // Regression: an expired Claude Code OAuth session exits 1 with an empty
  // stderr and the reason on stdout. The daemon posted only stderr, so the
  // thread showed "turn failed (exit 1) (no stderr)" and the user had no
  // way to know it was an auth problem.
  it('reports a failure the harness wrote to stdout, and names it as auth', async () => {
    const { poster, posts } = makePoster();
    const runner = createHeadlessTurnRunner(async () =>
      result({
        exitCode: 1,
        stderr: '',
        finalText: '',
        failureDetail:
          'Failed to authenticate: OAuth session expired and could not be refreshed',
      }),
    );

    await runner({ ...turnArgs, poster });

    const posted = posts.at(-1)?.text ?? '';
    expect(posted).toContain('OAuth session expired');
    expect(posted).not.toContain('(no stderr)');
    expect(posted).toContain('could not authenticate on this machine');
  });

  it('says so explicitly when a failed turn produced no output at all', async () => {
    const { poster, posts } = makePoster();
    const runner = createHeadlessTurnRunner(async () =>
      result({ exitCode: 1, stderr: '', finalText: '', failureDetail: null }),
    );

    await runner({ ...turnArgs, poster });

    expect(posts.at(-1)?.text).toContain(
      '(no output on stdout or stderr)',
    );
  });

  it('posts a visible error when output parsing throws', async () => {
    const { poster, posts } = makePoster();
    const runner = createHeadlessTurnRunner(async () => {
      throw new Error('invalid JSONL');
    });

    const outcome = await runner({ ...turnArgs, poster });

    expect(outcome.result).toBeNull();
    expect(outcome.thrown?.message).toBe('invalid JSONL');
    expect(posts.at(-1)?.text).toContain('codex turn errored: invalid JSONL');
  });
});

