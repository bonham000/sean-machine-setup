/**
 * CLI argument parser for the agent-comms binary.
 *
 * Subcommands: post, ask, monitor, reply, status, handled
 * Shared flags: --port, --json
 */

import { parseDuration } from './duration';

export type Subcommand =
  | 'post'
  | 'ask'
  | 'monitor'
  | 'reply'
  | 'status'
  | 'handled'
  | 'get-message';

interface SharedArgs {
  port: number;
  json: boolean;
}

interface LegacySharedArgs extends SharedArgs {
  text: string;
  cwd: string;
  sessionId?: string;
}

export interface PostArgs extends LegacySharedArgs {
  subcommand: 'post';
}

export interface AskArgs extends LegacySharedArgs {
  subcommand: 'ask';
  timeoutSeconds: number;
}

export interface MonitorArgs extends SharedArgs {
  subcommand: 'monitor';
  attachmentId: string;
  ownerToken?: string;
}

export interface ReplyArgs extends SharedArgs {
  subcommand: 'reply';
  attachmentId: string;
  messageId: string;
  text: string;
}

export interface StatusArgs extends SharedArgs {
  subcommand: 'status';
  attachmentId: string;
  text: string;
}

export interface HandledArgs extends SharedArgs {
  subcommand: 'handled';
  attachmentId: string;
  messageId: string;
}

export interface GetMessageArgs extends SharedArgs {
  subcommand: 'get-message';
  messageId: string;
}

export type AgentCommsArgs =
  | PostArgs
  | AskArgs
  | MonitorArgs
  | ReplyArgs
  | StatusArgs
  | HandledArgs
  | GetMessageArgs;

const USAGE = `
Usage:
  agent-comms post        --text <text> [options]
  agent-comms ask         --text <text> [options]
  agent-comms monitor     --attachment <id> [options]
  agent-comms reply       --attachment <id> --message-id <id> --text <text> [options]
  agent-comms status      --attachment <id> --text <text> [options]
  agent-comms handled     --attachment <id> --message-id <id> [options]
  agent-comms get-message --message-id <id> [options]

Shared options:
  --port <number>      Daemon port (default: AGENT_COMMS_PORT or 42100)
  --json               Print full daemon response as JSON

post/ask options:
  --text <text>        Message text (required)
  --cwd <path>         Working directory for session discovery (default: process.cwd())
  --session-id <id>    Override session ID (skip auto-discovery)

ask-only options:
  --timeout <duration> Block duration: 30s, 5m, 1h, 24h, 0=indefinite (default: 24h)

monitor-only options:
  --owner-token <token> Override the deterministic monitor owner token

get-message: fetch the full body of an inbound Slack message by id.
  Companion to monitor: monitor emits notification-only lines so they
  fit under CC's per-event Monitor stdout cap; get-message returns
  the full text over Bash (whose cap is much larger).
`.trim();

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseAgentCommsArgs(argv: string[]): AgentCommsArgs {
  const subcommand = argv[0];
  if (
    ![
      'post',
      'ask',
      'monitor',
      'reply',
      'status',
      'handled',
      'get-message',
    ].includes(subcommand ?? '')
  ) {
    throw new UsageError(
      `Unknown subcommand: "${subcommand ?? ''}". Expected: post | ask | monitor | reply | status | handled | get-message`,
    );
  }

  const rest = argv.slice(1);
  // Shared
  let port = Number(process.env.AGENT_COMMS_PORT ?? '42100');
  let json = false;
  // Legacy post/ask
  let text: string | undefined;
  let cwd = process.cwd();
  let sessionId: string | undefined;
  let timeout = '24h';
  // Durable subcommands
  let attachmentId: string | undefined;
  let messageId: string | undefined;
  let ownerToken: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = rest[i + 1];
    switch (flag) {
      case '--text':
        if (!next) throw new UsageError('--text requires a value');
        text = next;
        i++;
        break;
      case '--cwd':
        if (!next) throw new UsageError('--cwd requires a value');
        cwd = next;
        i++;
        break;
      case '--session-id':
        if (!next) throw new UsageError('--session-id requires a value');
        sessionId = next;
        i++;
        break;
      case '--attachment':
        if (!next) throw new UsageError('--attachment requires a value');
        attachmentId = next;
        i++;
        break;
      case '--message-id':
        if (!next) throw new UsageError('--message-id requires a value');
        messageId = next;
        i++;
        break;
      case '--owner-token':
        if (subcommand !== 'monitor') {
          throw new UsageError(
            '--owner-token is only valid for the "monitor" subcommand',
          );
        }
        if (!next) throw new UsageError('--owner-token requires a value');
        ownerToken = next;
        i++;
        break;
      case '--port': {
        if (!next) throw new UsageError('--port requires a value');
        const p = Number(next);
        if (!Number.isInteger(p) || p <= 0) {
          throw new UsageError(
            `--port must be a positive integer, got: ${next}`,
          );
        }
        port = p;
        i++;
        break;
      }
      case '--json':
        json = true;
        break;
      case '--timeout':
        if (subcommand !== 'ask') {
          throw new UsageError(
            '--timeout is only valid for the "ask" subcommand',
          );
        }
        if (!next) throw new UsageError('--timeout requires a value');
        timeout = next;
        i++;
        break;
      default:
        throw new UsageError(`Unknown flag: ${flag}`);
    }
  }

  if (subcommand === 'post') {
    if (!text) throw new UsageError('--text is required');
    return { subcommand: 'post', text, cwd, sessionId, port, json };
  }

  if (subcommand === 'ask') {
    if (!text) throw new UsageError('--text is required');
    let timeoutSeconds: number;
    try {
      timeoutSeconds = parseDuration(timeout);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    return {
      subcommand: 'ask',
      text,
      cwd,
      sessionId,
      port,
      json,
      timeoutSeconds,
    };
  }

  if (subcommand === 'monitor') {
    if (!attachmentId) throw new UsageError('--attachment is required');
    return { subcommand: 'monitor', attachmentId, ownerToken, port, json };
  }

  if (subcommand === 'reply') {
    if (!attachmentId) throw new UsageError('--attachment is required');
    if (!messageId) throw new UsageError('--message-id is required');
    if (!text) throw new UsageError('--text is required');
    return { subcommand: 'reply', attachmentId, messageId, text, port, json };
  }

  if (subcommand === 'status') {
    if (!attachmentId) throw new UsageError('--attachment is required');
    if (!text) throw new UsageError('--text is required');
    return { subcommand: 'status', attachmentId, text, port, json };
  }

  if (subcommand === 'get-message') {
    if (!messageId) throw new UsageError('--message-id is required');
    return { subcommand: 'get-message', messageId, port, json };
  }

  // handled
  if (!attachmentId) throw new UsageError('--attachment is required');
  if (!messageId) throw new UsageError('--message-id is required');
  return { subcommand: 'handled', attachmentId, messageId, port, json };
}

