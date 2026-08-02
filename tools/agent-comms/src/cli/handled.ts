/**
 * agent-comms handled — close a pending Slack message without a reply.
 *
 * Idempotent on (attachment_id, message_id): retries are safe.
 *
 * Exit codes:
 *   0 — success (or already_handled)
 *   1 — daemon error
 *   3 — daemon not running
 */

import type { HandledArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runHandled(
  args: HandledArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });

  const result = await client.handled({
    attachment_id: args.attachmentId,
    message_id: args.messageId,
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
  } else if (result.already_handled) {
    process.stdout.write(`already_handled\n`);
  } else {
    process.stdout.write(`ok\n`);
  }
}

