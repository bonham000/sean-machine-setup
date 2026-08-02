#!/usr/bin/env bun
/**
 * agent-comms — CC-facing Slack thread CLI.
 *
 * Usage:
 *   agent-comms post        --text <text> [--cwd <path>] [--session-id <id>] [--port <n>] [--json]
 *   agent-comms ask         --text <text> [--timeout <dur>] [--cwd <path>] [--session-id <id>] [--port <n>] [--json]
 *   agent-comms monitor     --attachment <id> [--owner-token <token>] [--port <n>] [--json]
 *   agent-comms reply       --attachment <id> --message-id <id> --text <text> [--port <n>] [--json]
 *   agent-comms status      --attachment <id> --text <text> [--port <n>] [--json]
 *   agent-comms handled     --attachment <id> --message-id <id> [--port <n>] [--json]
 *   agent-comms get-message --message-id <id> [--port <n>] [--json]
 *   agent-comms restart-after-reply [--port <n>] [--json]
 *
 * Duration formats: 30s, 5m, 1h, 24h, 0 (indefinite).
 *
 * Exit codes (consistent across subcommands):
 *   0 — success
 *   1 — daemon returned a non-special error (400 / 409 / 502 / etc.)
 *   2 — bad args
 *   3 — connection refused or daemon not installed (secret file missing)
 *   4 — 404 not found (monitor: attachment; get-message: message)
 *   5 — ask timed out (HTTP 408)
 *   6 — daemon shut down while waiting (HTTP 503; ask only)
 *   7 — 409 monitor already owned by another process
 */

import { parseAgentCommsArgs, UsageError } from './args';
import { runAsk } from './ask';
import { runGetMessage } from './get-message';
import { runHandled } from './handled';
import { runMonitor } from './monitor';
import { runPost } from './post';
import { runReply } from './reply';
import { runRestartAfterReply } from './restart-after-reply';
import { runStatus } from './status';

const argv = process.argv.slice(2);

let args: ReturnType<typeof parseAgentCommsArgs>;
try {
  args = parseAgentCommsArgs(argv);
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`agent-comms: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

try {
  switch (args.subcommand) {
    case 'post':
      await runPost(args);
      break;
    case 'ask':
      await runAsk(args);
      break;
    case 'monitor':
      await runMonitor(args);
      break;
    case 'reply':
      await runReply(args);
      break;
    case 'status':
      await runStatus(args);
      break;
    case 'handled':
      await runHandled(args);
      break;
    case 'get-message':
      await runGetMessage(args);
      break;
    case 'restart-after-reply':
      await runRestartAfterReply(args);
      break;
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  // Missing secret file means the daemon is not installed on this machine.
  // Treat as the same actionable state as connection-refused → exit 3, no stack trace.
  if (msg.startsWith('Secret file not found')) {
    process.stderr.write(`agent-comms: ${msg}\n`);
    process.exit(3);
  }
  process.stderr.write(`agent-comms: ${msg}\n`);
  process.exit(1);
}
