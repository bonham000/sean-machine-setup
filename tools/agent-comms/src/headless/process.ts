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
  /** The process never began executing and was killed by the startup watchdog. */
  stalledAtStartup?: boolean;
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

/**
 * How long a freshly spawned harness gets before the watchdog looks at it.
 * By this point a live harness has either burned well past
 * STARTUP_STALL_MAX_CPU_SECONDS booting its runtime or written some output.
 */
export const STARTUP_STALL_CHECK_MS = 30_000;

/**
 * CPU time below which a process is considered never to have started. The
 * observed stall sat at 0.03s for half an hour; a healthy boot is 1s+.
 */
export const STARTUP_STALL_MAX_CPU_SECONDS = 0.15;

/** Total spawn attempts for one turn when the startup watchdog keeps firing. */
export const STARTUP_STALL_MAX_ATTEMPTS = 3;

/** Parse `ps -o time=` output (`[dd-][hh:]mm:ss.ss`) into seconds. */
export function parsePsCpuTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [dayPart, clockPart] = trimmed.includes('-')
    ? (trimmed.split('-', 2) as [string, string])
    : ['0', trimmed];
  let seconds = 0;
  for (const field of clockPart.split(':')) {
    const value = Number(field);
    if (!Number.isFinite(value)) return null;
    seconds = seconds * 60 + value;
  }
  const days = Number(dayPart);
  if (!Number.isFinite(days)) return null;
  return days * 86_400 + seconds;
}

/** CPU seconds consumed by a live process, or null when it cannot be read. */
export async function readProcessCpuSeconds(
  pid: number,
): Promise<number | null> {
  try {
    const ps = Bun.spawn(['/bin/ps', '-o', 'time=', '-p', String(pid)], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(ps.stdout).text(),
      ps.exited,
    ]);
    return exitCode === 0 ? parsePsCpuTime(stdout) : null;
  } catch {
    return null;
  }
}

/** Drain a process stream to text, reporting each chunk's size as it lands. */
async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  onChunk: (byteLength: number) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    onChunk(chunk.byteLength);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export interface RunCommandOptions {
  startupStallCheckMs?: number;
  readCpuSeconds?: (pid: number) => Promise<number | null>;
}

/** Execute one harness turn without a shell so Slack text is never interpolated. */
export async function runCommandOnce(
  spec: CommandSpec,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const startupStallCheckMs =
    options.startupStallCheckMs ?? STARTUP_STALL_CHECK_MS;
  const readCpuSeconds = options.readCpuSeconds ?? readProcessCpuSeconds;

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

  // macOS can park a new process forever inside its very first open() of a
  // TCC-protected cwd (~/Documents) when sandboxd wedges mid permission
  // check. Such a process has run none of its own code — no output, no
  // transcript write — so killing it loses nothing and a respawn is safe.
  //
  // Both signals must agree: claude buffers its JSON until the end but burns
  // seconds of CPU booting, while codex boots cheaply but streams events at
  // once. A live harness always shows one of the two.
  let stalledAtStartup = false;
  let outputBytes = 0;
  const startupWatchdog = setTimeout(() => {
    void readCpuSeconds(proc.pid).then((cpuSeconds) => {
      if (cpuSeconds === null || cpuSeconds > STARTUP_STALL_MAX_CPU_SECONDS) {
        return;
      }
      if (outputBytes > 0) return;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      stalledAtStartup = true;
      console.error(
        `[agent-comms] ${spec.command} pid=${proc.pid} used ${cpuSeconds}s CPU in ${Math.round(startupStallCheckMs / 1000)}s — stalled before starting, killing it`,
      );
      proc.kill('SIGKILL');
    });
  }, startupStallCheckMs);

  try {
    const countBytes = (byteLength: number) => {
      outputBytes += byteLength;
    };
    const stdoutPromise = readStreamText(proc.stdout, countBytes);
    const stderrPromise = readStreamText(proc.stderr, countBytes);
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      stdout,
      stderr,
      exitCode,
      killed: spec.signal?.aborted ?? false,
      stalledAtStartup,
    };
  } finally {
    clearTimeout(startupWatchdog);
    spec.signal?.removeEventListener('abort', abort);
  }
}

/** Run a harness turn, respawning when the process stalls before it starts. */
export const runCommand: CommandRunner = async (spec) => {
  let result = await runCommandOnce(spec);
  for (
    let attempt = 2;
    result.stalledAtStartup &&
    !spec.signal?.aborted &&
    attempt <= STARTUP_STALL_MAX_ATTEMPTS;
    attempt += 1
  ) {
    console.error(
      `[agent-comms] respawning ${spec.command} after startup stall (attempt ${attempt}/${STARTUP_STALL_MAX_ATTEMPTS})`,
    );
    result = await runCommandOnce(spec);
  }
  return result;
};
