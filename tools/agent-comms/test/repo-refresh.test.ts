import { describe, expect, it, mock } from 'bun:test';
import {
  refreshRepoFamilyBeforeSession,
  runRepoRefresh,
} from '../src/session/repo-refresh';

describe('Slack session repo refresh', () => {
  it('runs the canonical repo-family pull command', async () => {
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
      ],
      cwd: '/Users/test/Documents/core-repo',
    });
  });

  it('fails the session preparation when the pull command fails', async () => {
    const runner = mock(async () => ({
      stdout: '',
      stderr: 'network unavailable',
      exitCode: 7,
      killed: false,
    }));

    expect(runRepoRefresh({ home: '/Users/test', runner })).rejects.toThrow(
      'repo refresh command exited 7: network unavailable',
    );
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
