import { describe, expect, it, mock } from 'bun:test';
import {
  refreshRepoFamilyBeforeSession,
  runRepoRefresh,
} from '../src/session/repo-refresh';

describe('Slack session repo refresh', () => {
  // Regression: repos:pull refuses to act without an explicit selector, so
  // the bare invocation exited 201 and silently pulled nothing before every
  // Slack session.
  it('selects every registered repo, which repos:pull requires explicitly', async () => {
    const runner = mock(async () => ({
      stdout: 'Pulling repos...',
      stderr: '',
      exitCode: 0,
      killed: false,
    }));

    await runRepoRefresh({ home: '/Users/test', runner });

    expect(runner).toHaveBeenCalledWith({
      command: 'task',
      args: [
        '-d',
        '/Users/test/Documents/core-repo',
        'repos:pull',
        '--',
        '--all',
      ],
      cwd: '/Users/test/Documents/core-repo',
    });
  });

  it('does not fail the session when the pull command exits non-zero', async () => {
    const runner = mock(async () => ({
      stdout: '',
      stderr: 'network unavailable',
      exitCode: 7,
      killed: false,
    }));

    await expect(
      runRepoRefresh({ home: '/Users/test', runner }),
    ).resolves.toBeUndefined();
  });

  it('does not fail the session when the pull command cannot run', async () => {
    const runner = mock(async () => {
      throw new Error('command not found');
    });

    await expect(
      runRepoRefresh({ home: '/Users/test', runner }),
    ).resolves.toBeUndefined();
  });

  it('shares a concurrent refresh so git operations cannot race', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = mock(async () => {
      await gate;
      return { stdout: '', stderr: '', exitCode: 0, killed: false };
    });

    const first = refreshRepoFamilyBeforeSession({
      home: '/Users/test',
      runner,
    });
    const second = refreshRepoFamilyBeforeSession({
      home: '/Users/test',
      runner,
    });
    expect(runner).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
  });
});
