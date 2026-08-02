export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

/** Execute one harness turn without a shell so Slack text is never interpolated. */
export const runCommand: CommandRunner = async (spec) => {
  const proc = Bun.spawn([spec.command, ...spec.args], {
    cwd: spec.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // launchd starts with a sparse environment; all three harnesses expect
      // these ordinary process identity and locale values to exist.
      USER: process.env.USER ?? process.env.LOGNAME ?? 'user',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'user',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
    },
  });

  const abort = () => proc.kill('SIGTERM');
  if (spec.signal?.aborted) abort();
  else spec.signal?.addEventListener('abort', abort, { once: true });

  try {
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      stdout,
      stderr,
      exitCode,
      killed: spec.signal?.aborted ?? false,
    };
  } finally {
    spec.signal?.removeEventListener('abort', abort);
  }
};

