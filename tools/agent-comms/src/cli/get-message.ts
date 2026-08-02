/**
 * agent-comms get-message — fetch a single inbound Slack message body by id.
 *
 * Companion to `agent-comms monitor`. The Monitor tool in Claude Code applies
 * a small per-event stdout cap that clips long lines with a literal
 * `...(truncated)` suffix — small enough that a single Slack message often
 * does not fit. To avoid that, the monitor emits notification-only lines
 * (id + metadata) and CC reads the full body via this command over Bash,
 * which has a much larger output cap.
 *
 * Default stdout: just the message text (printed exactly as stored, with a
 * single trailing newline). Use --json to receive the full message row.
 *
 * Exit codes (see src/cli/index.ts for the full contract):
 *   0 — success
 *   1 — daemon returned a non-special error
 *   3 — daemon not running (connection refused / secret missing)
 *   4 — 404 message not found
 */

import type { GetMessageArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runGetMessage(
  args: GetMessageArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });
  const result = await client.getMessage(args.messageId);

  if (!result.ok) {
    if (result.status === -1) {
      process.stderr.write(`agent-comms: ${result.error}\n`);
      process.exit(3);
    }
    if (result.status === 404) {
      process.stderr.write(
        `agent-comms: message ${args.messageId} not found\n`,
      );
      process.exit(4);
    }
    process.stderr.write(`agent-comms: daemon error: ${result.error}\n`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    // Print the raw body verbatim. This intentionally does NOT add prefix
    // metadata so CC sees exactly what the user typed in Slack.
    process.stdout.write(`${result.message.text}\n`);
  }
}

