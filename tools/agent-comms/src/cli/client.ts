/**
 * HTTP client for agent-comms CLI commands.
 *
 * Reads the shared secret from disk and sends X-Agent-Comms-Secret.
 * All dependencies are injectable so tests can substitute fakes.
 */

import { readFileSync } from 'node:fs';
import type { MessageRow } from '../registry';
import { getSecretPath } from '../secret';

export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ClientDeps {
  secretPath?: string;
  port?: number;
  fetch?: FetchFn;
}

// ---- Legacy response types ----

export interface PostResult {
  ok: true;
  thread_url: string;
  created: boolean;
}

export interface AskResult {
  ok: true;
  reply: string;
  thread_url: string;
}

// ---- Phase 2 response types ----

export interface AttachLiveResult {
  ok: true;
  attachment_id: string;
  status: string;
  thread_ts: string;
  thread_url: string;
  created: boolean;
}

export interface MonitorWaitResult {
  ok: true;
  messages: MessageRow[];
}

export interface MonitorCheckinResult {
  ok: true;
}

export interface MonitorEmittedResult {
  ok: true;
  transitioned: number;
}

export interface ReplyResult {
  ok: true;
  already_handled?: boolean;
  slack_ts?: string;
}

export interface StatusResult {
  ok: true;
  slack_ts?: string;
}

export interface HandledResult {
  ok: true;
  already_handled?: boolean;
}

export interface GetMessageResult {
  ok: true;
  message: MessageRow;
}

export interface RestartAfterReplyResult {
  ok: true;
  status: 'queued' | 'already_queued';
}

export type DaemonError = {
  ok: false;
  error: string;
  status: number;
};

export type ClientResult<T> = T | DaemonError;

// ---- Request types ----

export interface PostRequest {
  cwd: string;
  text: string;
  session_id?: string;
}

export interface AskRequest {
  cwd: string;
  text: string;
  timeout_seconds?: number;
  session_id?: string;
}

export interface AttachLiveRequest {
  cwd: string;
  session_id?: string;
  hint?: string;
  channel_id?: string;
  thread_ts?: string;
  owner_mode?: 'terminal-attached' | 'daemon-spawned';
}

export interface MonitorCheckinRequest {
  owner_token: string;
  pid?: number;
  started_at?: number;
  emitted_ids?: string[];
}

export interface MonitorEmittedRequest {
  owner_token: string;
  message_ids: string[];
}

export interface ReplyRequest {
  attachment_id: string;
  message_id: string;
  text: string;
}

export interface StatusRequest {
  attachment_id: string;
  text: string;
}

export interface HandledRequest {
  attachment_id: string;
  message_id: string;
}

// ---- Internal helpers ----

function readSecret(secretPath: string): string {
  try {
    return readFileSync(secretPath, 'utf8').trim();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Secret file not found: ${secretPath}\n` +
          'Install and start the agent-comms daemon first (Mac Mini only):\n' +
          '  task -d ~/Documents/sean-machine-setup agent-comms:install',
      );
    }
    throw err;
  }
}

async function request<T>(
  deps: { secretPath: string; port: number; fetch: FetchFn },
  path: string,
  body: unknown,
): Promise<ClientResult<T>> {
  const secret = readSecret(deps.secretPath);
  const url = `http://127.0.0.1:${deps.port}${path}`;

  let resp: Response;
  try {
    resp = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Comms-Secret': secret,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isConnRefused =
      msg.includes('ECONNREFUSED') ||
      msg.includes('Connection refused') ||
      msg.includes('connect ECONNREFUSED');
    if (isConnRefused) {
      return {
        ok: false,
        status: -1,
        error:
          'Connection refused. The agent-comms daemon is not running.\n' +
          'This CLI (v1) only works when the daemon is running on the Mac Mini.\n' +
          'See the README for install instructions.',
      };
    }
    return { ok: false, status: -1, error: msg };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return {
      ok: false,
      status: resp.status,
      error: `Non-JSON response (HTTP ${resp.status})`,
    };
  }

  if (!resp.ok) {
    const error =
      (json as Record<string, unknown>)?.error ?? `HTTP ${resp.status}`;
    return { ok: false, status: resp.status, error: String(error) };
  }

  return json as T;
}

async function requestGet<T>(
  deps: { secretPath: string; port: number; fetch: FetchFn },
  path: string,
  queryParams: Record<string, string>,
  extraInit?: RequestInit,
): Promise<ClientResult<T>> {
  const secret = readSecret(deps.secretPath);
  const qs = new URLSearchParams(queryParams).toString();
  const url = `http://127.0.0.1:${deps.port}${path}${qs ? `?${qs}` : ''}`;

  let resp: Response;
  try {
    resp = await deps.fetch(url, {
      method: 'GET',
      headers: {
        'X-Agent-Comms-Secret': secret,
        ...(extraInit?.headers as Record<string, string> | undefined),
      },
      ...extraInit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isConnRefused =
      msg.includes('ECONNREFUSED') ||
      msg.includes('Connection refused') ||
      msg.includes('connect ECONNREFUSED');
    if (isConnRefused) {
      return {
        ok: false,
        status: -1,
        error:
          'Connection refused. The agent-comms daemon is not running.\n' +
          'This CLI only works when the daemon is running on the Mac Mini.\n' +
          'See the README for install instructions.',
      };
    }
    return { ok: false, status: -1, error: msg };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return {
      ok: false,
      status: resp.status,
      error: `Non-JSON response (HTTP ${resp.status})`,
    };
  }

  if (!resp.ok) {
    const error =
      (json as Record<string, unknown>)?.error ?? `HTTP ${resp.status}`;
    return { ok: false, status: resp.status, error: String(error) };
  }

  return json as T;
}

// ---- Public client ----

export function createClient(deps: ClientDeps = {}): {
  post: (req: PostRequest) => Promise<ClientResult<PostResult>>;
  ask: (req: AskRequest) => Promise<ClientResult<AskResult>>;
  attachLive: (
    req: AttachLiveRequest,
  ) => Promise<ClientResult<AttachLiveResult>>;
  monitorWait: (params: {
    attachmentId: string;
    ownerToken: string;
    pid: number;
    startedAt: number;
    signal?: AbortSignal;
  }) => Promise<ClientResult<MonitorWaitResult>>;
  monitorCheckin: (
    attachmentId: string,
    body: MonitorCheckinRequest,
  ) => Promise<ClientResult<MonitorCheckinResult>>;
  monitorEmitted: (
    body: MonitorEmittedRequest,
  ) => Promise<ClientResult<MonitorEmittedResult>>;
  reply: (req: ReplyRequest) => Promise<ClientResult<ReplyResult>>;
  status: (req: StatusRequest) => Promise<ClientResult<StatusResult>>;
  handled: (req: HandledRequest) => Promise<ClientResult<HandledResult>>;
  getMessage: (messageId: string) => Promise<ClientResult<GetMessageResult>>;
  restartAfterReply: () => Promise<ClientResult<RestartAfterReplyResult>>;
} {
  const resolved = {
    secretPath: deps.secretPath ?? getSecretPath(),
    port: deps.port ?? Number(process.env.AGENT_COMMS_PORT ?? '42100'),
    fetch: deps.fetch ?? (globalThis.fetch as FetchFn),
  };

  return {
    post: (req) => request<PostResult>(resolved, '/post', req),
    ask: (req) => request<AskResult>(resolved, '/ask', req),
    attachLive: (req) =>
      request<AttachLiveResult>(resolved, '/attach-live', req),
    monitorWait: ({ attachmentId, ownerToken, pid, startedAt, signal }) =>
      requestGet<MonitorWaitResult>(
        resolved,
        '/monitor/wait',
        {
          attachment: attachmentId,
          owner_token: ownerToken,
          pid: String(pid),
          started_at: String(startedAt),
        },
        signal ? { signal } : undefined,
      ),
    monitorCheckin: (attachmentId, body) =>
      request<MonitorCheckinResult>(
        resolved,
        `/monitor/checkin?attachment=${encodeURIComponent(attachmentId)}`,
        body,
      ),
    monitorEmitted: (body) =>
      request<MonitorEmittedResult>(resolved, '/monitor/emitted', body),
    reply: (req) => request<ReplyResult>(resolved, '/reply', req),
    status: (req) => request<StatusResult>(resolved, '/status', req),
    handled: (req) => request<HandledResult>(resolved, '/handled', req),
    getMessage: (messageId) =>
      requestGet<GetMessageResult>(
        resolved,
        `/messages/${encodeURIComponent(messageId)}`,
        {},
      ),
    restartAfterReply: () =>
      request<RestartAfterReplyResult>(resolved, '/restart-after-reply', {}),
  };
}
