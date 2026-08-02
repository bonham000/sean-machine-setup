import { describe, expect, it, mock } from 'bun:test';
import {
  type HeadlessHarnessTurnArgs,
  normalizeHeadlessHarnessId,
  preflightHeadlessHarness,
  runHeadlessHarnessTurn,
} from '../src/headless/harness';
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
} from '../src/headless/process';

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    killed: false,
    ...overrides,
  };
}

function harnessArgs(
  overrides: Partial<HeadlessHarnessTurnArgs> = {},
): HeadlessHarnessTurnArgs {
  return {
    harness: 'claude',
    prompt: 'Do the work',
    cwd: '/repo',
    systemPrompt: 'Answer for Slack',
    ...overrides,
  };
}

describe('headless harness identifiers', () => {
  it('normalizes canonical IDs and the stored Claude compatibility alias', () => {
    expect(normalizeHeadlessHarnessId('CLAUDE')).toBe('claude');
    expect(normalizeHeadlessHarnessId('codex')).toBe('codex');
    expect(normalizeHeadlessHarnessId(' pi ')).toBe('pi');
    expect(normalizeHeadlessHarnessId('claude-code')).toBe('claude');
    expect(normalizeHeadlessHarnessId('gemini')).toBeNull();
  });
});

describe('preflightHeadlessHarness', () => {
  it('launches the selected executable with --version', async () => {
    const runner = mock(async (_spec: CommandSpec) => commandResult());
    await preflightHeadlessHarness('codex', '/repo', runner);
    expect(runner).toHaveBeenCalledWith({
      command: 'codex',
      args: ['--version'],
      cwd: '/repo',
    });
  });

  it('rejects a harness whose version command fails', async () => {
    const runner: CommandRunner = async () =>
      commandResult({ exitCode: 127, stderr: 'command not found' });
    expect(preflightHeadlessHarness('pi', '/repo', runner)).rejects.toThrow(
      'pi --version exited 127',
    );
  });
});

describe('runHeadlessHarnessTurn', () => {
  it('starts a Claude session and parses its final result', async () => {
    const runner = mock(async (_spec: CommandSpec) =>
      commandResult({
        stdout: JSON.stringify({
          result: 'Claude complete',
          session_id: 'claude-session',
        }),
      }),
    );
    const result = await runHeadlessHarnessTurn(harnessArgs(), {
      commandRunner: runner,
    });

    expect(result.sessionId).toBe('claude-session');
    expect(result.finalText).toBe('Claude complete');
    const spec = runner.mock.calls[0]![0];
    expect(spec.command).toBe('claude');
    expect(spec.args).toContain('--output-format');
    expect(spec.args).toContain('bypassPermissions');
    expect(spec.args).not.toContain('--resume');
  });

  it('resumes Claude by its stored session ID', async () => {
    const runner = mock(async (_spec: CommandSpec) =>
      commandResult({
        stdout: JSON.stringify({
          result: 'Claude resumed',
          session_id: 'claude-session',
        }),
      }),
    );
    await runHeadlessHarnessTurn(harnessArgs({ sessionId: 'claude-session' }), {
      commandRunner: runner,
    });
    expect(runner.mock.calls[0]![0].args).toContain('--resume');
    expect(runner.mock.calls[0]![0].args).toContain('claude-session');
  });

  it('starts Codex, parses thread.started, and captures the last agent message', async () => {
    const runner = mock(async (_spec: CommandSpec) =>
      commandResult({
        stdout: [
          JSON.stringify({
            type: 'thread.started',
            thread_id: 'codex-session',
          }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'intermediate' },
          }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Codex complete' },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }),
    );
    const result = await runHeadlessHarnessTurn(
      harnessArgs({ harness: 'codex' }),
      { commandRunner: runner },
    );

    expect(result.sessionId).toBe('codex-session');
    expect(result.finalText).toBe('Codex complete');
    expect(runner.mock.calls[0]![0].args.slice(0, 2)).toEqual([
      'exec',
      '--json',
    ]);
    expect(runner.mock.calls[0]![0].args).toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('resumes Codex with exec resume and preserves the existing ID', async () => {
    const runner = mock(async (_spec: CommandSpec) =>
      commandResult({
        stdout: [
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Codex resumed' },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }),
    );
    const result = await runHeadlessHarnessTurn(
      harnessArgs({ harness: 'codex', sessionId: 'codex-session' }),
      { commandRunner: runner },
    );

    expect(result.sessionId).toBe('codex-session');
    expect(runner.mock.calls[0]![0].args.slice(0, 2)).toEqual([
      'exec',
      'resume',
    ]);
    expect(runner.mock.calls[0]![0].args).toContain('codex-session');
  });

  it('starts Pi with a generated ID and parses its final assistant message', async () => {
    const runner = mock(async (_spec: CommandSpec) =>
      commandResult({
        stdout: [
          JSON.stringify({ type: 'session', id: 'pi-session' }),
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [
                { type: 'text', text: 'Pi' },
                { type: 'text', text: 'complete' },
              ],
            },
          }),
        ].join('\n'),
      }),
    );
    const result = await runHeadlessHarnessTurn(
      harnessArgs({ harness: 'pi' }),
      {
        commandRunner: runner,
        sessionIdFactory: () => 'pi-session',
      },
    );

    expect(result.sessionId).toBe('pi-session');
    expect(result.finalText).toBe('Pi\ncomplete');
    expect(runner.mock.calls[0]![0].args).toContain('--session-id');
    expect(runner.mock.calls[0]![0].args).toContain('pi-session');
    expect(runner.mock.calls[0]![0].args).toContain('--approve');
  });

  it('resumes Pi with the existing exact session ID', async () => {
    const runner = mock(async (_spec: CommandSpec) =>
      commandResult({
        stdout: [
          JSON.stringify({ type: 'session', id: 'pi-session' }),
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: 'Pi resumed' }],
            },
          }),
        ].join('\n'),
      }),
    );
    await runHeadlessHarnessTurn(
      harnessArgs({ harness: 'pi', sessionId: 'pi-session' }),
      { commandRunner: runner },
    );
    expect(runner.mock.calls[0]![0].args).toContain('pi-session');
  });

  it('returns a failed process result without attempting to parse stdout', async () => {
    const result = await runHeadlessHarnessTurn(harnessArgs(), {
      commandRunner: async () =>
        commandResult({ exitCode: 1, stderr: 'auth failed' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('auth failed');
    expect(result.finalText).toBe('');
  });

  it('rejects a successful process with no final agent message', async () => {
    expect(
      runHeadlessHarnessTurn(harnessArgs({ harness: 'codex' }), {
        commandRunner: async () =>
          commandResult({
            stdout: JSON.stringify({
              type: 'thread.started',
              thread_id: 'codex-session',
            }),
          }),
      }),
    ).rejects.toThrow('codex completed without a final agent message');
  });
});

