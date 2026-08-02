import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runCommand,
  type CommandResult,
  type CommandRunner,
} from '../headless/process';

export interface RepoRefreshOptions {
  home?: string;
  runner?: CommandRunner;
}

function resultDetail(result: CommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  return detail ? `: ${detail.slice(0, 800)}` : '';
}

/** Run the repo family's canonical pull command before a Slack session starts. */
export async function runRepoRefresh(
  options: RepoRefreshOptions = {},
): Promise<void> {
  const coreRepo = join(
    options.home ?? homedir(),
    'Documents',
    'core-repo',
  );
  const runner = options.runner ?? runCommand;

  console.log(
    `[agent-comms] refreshing repo family before session: task -d ${coreRepo} repos:pull`,
  );

  let result: CommandResult | null = null;
  try {
    result = await runner({
      command: 'task',
      args: ['-d', coreRepo, 'repos:pull'],
      cwd: coreRepo,
    });
  } catch (error) {
    console.warn(
      `[agent-comms] repo family refresh command failed to execute; continuing anyway: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (result.exitCode !== 0) {
    console.warn(
      `[agent-comms] repo family refresh command exited ${result.exitCode}${resultDetail(result)}; continuing anyway`,
    );
    return;
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  console.log(
    output
      ? `[agent-comms] repo family refresh complete\n${output}`
      : '[agent-comms] repo family refresh complete',
  );
}

// Socket Mode can deliver two new-session mentions concurrently. Share an
// in-flight refresh so two git processes never race over the same checkouts.
let inFlightRefresh: Promise<void> | null = null;

export function refreshRepoFamilyBeforeSession(
  options: RepoRefreshOptions = {},
): Promise<void> {
  if (inFlightRefresh) return inFlightRefresh;

  const refresh = runRepoRefresh(options);
  const tracked = refresh.finally(() => {
    if (inFlightRefresh === tracked) inFlightRefresh = null;
  });
  inFlightRefresh = tracked;
  return tracked;
}
