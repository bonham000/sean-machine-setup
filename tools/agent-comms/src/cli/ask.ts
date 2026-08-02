/**
 * agent-comms ask — blocking ask to the attached Slack thread.
 *
 * Stdout: reply text (or full JSON with --json)
 * Exit codes (see src/cli/index.ts for the full contract):
 *   0 — success (the user replied)
 *   1 — daemon returned a non-special error (400 / 404 / 409 / 502)
 *   3 — connection refused (daemon not running)
 *   5 — 408 timed out
 *   6 — 503 daemon shutdown
 */

import type { AskArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runAsk(
  args: AskArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });
  const result = await client.ask({
    cwd: args.cwd,
    text: args.text,
    session_id: args.sessionId,
    timeout_seconds: args.timeoutSeconds,
  });

  if (!result.ok) {
    if (result.status === -1) {
      process.stderr.write(`agent-comms: ${result.error}\n`);
      process.exit(3);
    }
    if (result.status === 408) {
      process.stderr.write('agent-comms: timed out waiting for reply\n');
      process.exit(5);
    }
    if (result.status === 503) {
      process.stderr.write(
        'agent-comms: daemon shut down while waiting for reply\n',
      );
      process.exit(6);
    }
    process.stderr.write(`agent-comms: daemon error: ${result.error}\n`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${result.reply}\n`);
  }
}

