/**
 * agent-comms post — fire-and-forget post to the attached Slack thread.
 *
 * Stdout: thread_url (or full JSON with --json)
 * Exit codes (see src/cli/index.ts for the full contract):
 *   0 — success
 *   1 — daemon returned a non-special error (400 / 404 / 502)
 *   3 — connection refused (daemon not running)
 */

import type { PostArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runPost(
  args: PostArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });
  const result = await client.post({
    cwd: args.cwd,
    text: args.text,
    session_id: args.sessionId,
  });

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
    process.stdout.write(`${result.thread_url}\n`);
  }
}

