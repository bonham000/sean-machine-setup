/** Queue a daemon restart after all headless turns finish posting to Slack. */

import type { RestartAfterReplyArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runRestartAfterReply(
  args: RestartAfterReplyArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });
  const result = await client.restartAfterReply();

  if (!result.ok) {
    if (result.status === -1) {
      process.stderr.write(`agent-comms: ${result.error}\n`);
      process.exit(3);
    }
    process.stderr.write(`agent-comms: daemon error: ${result.error}\n`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${result.status}\n`);
  }
}
