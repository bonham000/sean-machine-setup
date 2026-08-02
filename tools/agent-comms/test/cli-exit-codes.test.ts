/**
 * Top-level CLI exit-code contract.
 *
 * Locks the exit codes documented in src/cli/index.ts that consumers
 * (e.g. CC tool wrappers) may rely on.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe('agent-comms CLI exit codes', () => {
  it('exits 2 on bad args (unknown subcommand)', async () => {
    const { code, stderr } = await runCli(['nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown subcommand');
  });

  it('exits 2 on missing --text', async () => {
    const { code, stderr } = await runCli(['post']);
    expect(code).toBe(2);
    expect(stderr).toContain('--text is required');
  });

  it('exits 3 when the secret file is missing (no stack trace)', async () => {
    const { code, stderr, stdout } = await runCli(
      ['post', '--text', 'hi', '--cwd', '/tmp', '--port', '42100'],
      { HOME: '/tmp/agent-comms-test-nonexistent-home' },
    );
    expect(code).toBe(3);
    expect(stderr).toContain('Secret file not found');
    // Clean error — no stack trace
    expect(stderr).not.toContain('    at ');
    expect(stdout).toBe('');
  });
});

