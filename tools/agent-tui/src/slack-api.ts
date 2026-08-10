import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const SLACK_API = "https://slack.com/api";
const MARKDOWN_BLOCK_LIMIT = 12_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SlackConfig = {
  token: string;
  channelId: string;
  allowedUsers: Set<string>;
  notifyUserId: string | null;
  machineId: string;
};

export type SlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
};

// Parameter properties are deliberately avoided here: the daemon and the Slack
// bridge run under Node type stripping, which only erases types.
export class SlackRateLimitError extends Error {
  readonly method: string;
  readonly retryAfterMs: number;

  constructor(method: string, retryAfterMs: number) {
    super(`Slack ${method} failed: ratelimited`);
    this.name = "SlackRateLimitError";
    this.method = method;
    this.retryAfterMs = retryAfterMs;
  }
}

export function compareSlackTs(left: string, right: string): number {
  const [leftSeconds = "0", leftMicros = "0"] = left.split(".");
  const [rightSeconds = "0", rightMicros = "0"] = right.split(".");
  const seconds = Number(leftSeconds) - Number(rightSeconds);
  if (seconds !== 0) return seconds;
  return Number(leftMicros.padEnd(6, "0")) - Number(rightMicros.padEnd(6, "0"));
}

export function parseEnvFile(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

// Following a thread only earns a conditional notification: Slack suppresses it
// whenever the client is focused on the conversation or the desktop session is
// active. A mention is the only unconditional tier, so detached-session posts
// end with one.
export function withMention(text: string, userId?: string | null): string {
  return userId ? `${text}\n\n<@${userId}>` : text;
}

export function splitSlackMarkdown(markdown: string, limit = MARKDOWN_BLOCK_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = markdown;
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n\n", limit);
    if (boundary < limit / 2) boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit / 2) boundary = limit;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function machineIdentity(): Promise<string> {
  if (process.env.MACHINE_ID) return process.env.MACHINE_ID;
  try {
    const identity = await readFile(join(process.env.HOME ?? "", ".AGENT_MACHINE_IDENTITY"), "utf8");
    const values = parseEnvFile(identity);
    if (values.MACHINE_ID) return values.MACHINE_ID;
    if (identity.trim() && !identity.includes("=")) return identity.trim();
  } catch {
    // Fall back to the host name.
  }
  return hostname().replace(/\.local$/, "");
}

export async function loadSlackConfig(_cwd: string): Promise<SlackConfig> {
  const candidates = [
    process.env.AGENT_TUI_ENV_FILE,
    join(process.env.HOME ?? homedir(), ".config", "agent-tui", ".env"),
  ].filter((value): value is string => Boolean(value));

  const fileSources: Array<Record<string, string>> = [];
  for (const candidate of new Set(candidates)) {
    try {
      fileSources.push(parseEnvFile(await readFile(candidate, "utf8")));
    } catch {
      // Optional config sources may not exist on every machine.
    }
  }

  const value = (key: string) => process.env[key] || fileSources.find((source) => source[key])?.[key];
  const token = value("SLACK_BOT_TOKEN_AGENT_COMMS");
  const channelId = value("SLACK_AGENT_COMMS_CHANNEL");
  const allowed = value("SLACK_AGENT_COMMS_ALLOWED_USERS");
  if (!token) throw new Error("SLACK_BOT_TOKEN_AGENT_COMMS is missing");
  if (!channelId) throw new Error("SLACK_AGENT_COMMS_CHANNEL is missing");
  if (!allowed) throw new Error("SLACK_AGENT_COMMS_ALLOWED_USERS is missing; refusing an unrestricted control thread");

  const allowedUsers = new Set(allowed.split(",").map((item) => item.trim()).filter(Boolean));

  // The allowlist is an authorization set, so it only doubles as the mention
  // target while it names exactly one person. Beyond that the choice is
  // ambiguous and must be stated explicitly rather than guessed.
  const notifyOverride = value("SLACK_AGENT_COMMS_NOTIFY_USER")?.trim();
  const notifyUserId = notifyOverride || (allowedUsers.size === 1 ? [...allowedUsers][0]! : null);

  return {
    token,
    channelId,
    allowedUsers,
    notifyUserId,
    machineId: await machineIdentity(),
  };
}

export class SlackApi {
  private readonly token: string;
  private readonly fetchImpl: Fetch;

  constructor(
    token: string,
    fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    options: { post?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let retryDelayMs = 500 * (attempt + 1);
      try {
        const query = new URLSearchParams(
          Object.entries(params).map(([key, value]) => [key, String(value)]),
        );
        const response = await this.fetchImpl(
          options.post ? `${SLACK_API}/${method}` : `${SLACK_API}/${method}?${query}`,
          {
            method: options.post ? "POST" : "GET",
            headers: {
              Authorization: `Bearer ${this.token}`,
              ...(options.post ? { "Content-Type": "application/json; charset=utf-8" } : {}),
            },
            ...(options.post ? { body: JSON.stringify(params) } : {}),
            signal: controller.signal,
          },
        );
        const body = (await response.json()) as Record<string, unknown>;
        if (body.ok === true) return body;
        lastError = new Error(`Slack ${method} failed: ${String(body.error ?? response.status)}`);
        if (body.error === "ratelimited" || response.status === 429) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          throw new SlackRateLimitError(
            method,
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 60_000,
          );
        } else if (response.status < 500) {
          break;
        }
      } catch (error) {
        if (error instanceof SlackRateLimitError) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    }
    throw lastError ?? new Error(`Slack ${method} failed`);
  }

  async authTest(): Promise<{ userId: string; teamId: string; workspaceUrl: string }> {
    const body = await this.call("auth.test", {});
    return {
      userId: String(body.user_id),
      teamId: String(body.team_id ?? body.team),
      workspaceUrl: String(body.url ?? "https://app.slack.com/"),
    };
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
    const body = await this.call("chat.postMessage", {
      channel,
      text: text.slice(0, 39_000),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }, { post: true });
    return String(body.ts);
  }

  async updateMessage(channel: string, timestamp: string, text: string): Promise<void> {
    await this.call("chat.update", {
      channel,
      ts: timestamp,
      text: text.slice(0, 39_000),
    }, { post: true });
  }

  async postMarkdownMessage(
    channel: string,
    markdown: string,
    threadTs?: string,
    mentionUserId?: string | null,
  ): Promise<string> {
    let timestamp = "";
    // Mentioning before the split keeps the ping on the final chunk, so a
    // multi-chunk response notifies once when it is complete rather than once
    // per chunk while it is still arriving.
    for (const chunk of splitSlackMarkdown(withMention(markdown, mentionUserId))) {
      const body = await this.call("chat.postMessage", {
        channel,
        text: chunk,
        blocks: [{ type: "markdown", text: chunk }],
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }, { post: true });
      timestamp = String(body.ts);
    }
    return timestamp;
  }

  async history(channel: string, limit = 100): Promise<SlackMessage[]> {
    const body = await this.call("conversations.history", { channel, limit: String(limit) });
    return (body.messages ?? []) as SlackMessage[];
  }

  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const body = await this.call("conversations.replies", {
        channel,
        ts: threadTs,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...((body.messages ?? []) as SlackMessage[]));
      const metadata = body.response_metadata as { next_cursor?: string } | undefined;
      cursor = metadata?.next_cursor ?? "";
      if (!body.has_more || !cursor) break;
    }
    return messages.sort((left, right) => compareSlackTs(left.ts, right.ts));
  }

  async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.call("reactions.add", { channel, timestamp, name }, { post: true });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already_reacted")) throw error;
    }
  }
}
