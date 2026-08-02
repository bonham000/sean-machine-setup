/**
 * agent-comms status — fire-and-forget status post to the attached Slack thread.
 *
 * Not deduped. Stdout: slack_ts of the posted message (or full JSON with --json)
 * Exit codes:
 *   0 — success
 *   1 — daemon error
 *   3 — daemon not running
 */

import type { StatusArgs } from './args';
import type { ClientDeps } from './client';
import { createClient } from './client';

export async function runStatus(
  args: StatusArgs,
  deps: ClientDeps = {},
): Promise<void> {
  const client = createClient({ ...deps, port: args.port });

  const result = await client.status({
    attachment_id: args.attachmentId,
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
  } else {
    process.stdout.write(`${result.slack_ts ?? 'ok'}\n`);
  }
}

