/**
 * agent-comms reply — post a reply to a specific Slack message.
 *
 * Idempotent on (attachment_id, message_id): retries are safe.
 *
 * Stdout: slack_ts of the posted reply (or full JSON with --json)
 * Exit codes:
 *   0 — success (or already_handled)
 *   1 — daemon error
 *   3 — daemon not running
 */

import type { ReplyArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runReply(
  args: ReplyArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });

  const result = await client.reply({
    attachment_id: args.attachmentId,
    message_id: args.messageId,
    text: args.text,
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
    process.stdout.write(`${result.slack_ts ?? 'ok'}\n`);
  }
}

