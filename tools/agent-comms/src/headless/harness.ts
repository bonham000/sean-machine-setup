import type { CommandResult, CommandRunner } from './process';
import { runCommand } from './process';

export const HEADLESS_HARNESS_IDS = ['claude', 'codex', 'pi'] as const;
export type HeadlessHarnessId = (typeof HEADLESS_HARNESS_IDS)[number];

export const HEADLESS_HARNESS_LABELS: Record<HeadlessHarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

/** Accept the old stored Claude runtime while writing only canonical IDs. */
export function normalizeHeadlessHarnessId(
  value: string,
): HeadlessHarnessId | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude-code') return 'claude';
  return HEADLESS_HARNESS_IDS.find((id) => id === normalized) ?? null;
}

export interface HeadlessHarnessTurnArgs {
  harness: HeadlessHarnessId;
  prompt: string;
  cwd: string;
  sessionId?: string;
  systemPrompt: string;
  signal?: AbortSignal;
}

export interface HeadlessHarnessTurnResult extends CommandResult {
  finalText: string;
  sessionId: string | null;
}

export interface HeadlessHarnessDeps {
  commandRunner?: CommandRunner;
  sessionIdFactory?: () => string;
}

export async function preflightHeadlessHarness(
  harness: HeadlessHarnessId,
  cwd: string,
  commandRunner: CommandRunner = runCommand,
): Promise<void> {
  const result = await commandRunner({
    command: harness,
    args: ['--version'],
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${harness} --version exited ${result.exitCode}: ${result.stderr.trim() || 'no error output'}`,
    );
  }
}

interface JsonRecord {
  [key: string]: unknown;
}

function parseJsonObject(raw: string, harness: HeadlessHarnessId): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected an object');
    }
    return parsed as JsonRecord;
  } catch (error) {
    throw new Error(
      `${harness} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonLines(raw: string, harness: HeadlessHarnessId): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected an object');
      }
      records.push(parsed as JsonRecord);
    } catch (error) {
      throw new Error(
        `${harness} returned invalid JSONL on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return records;
}

function stringField(
  record: JsonRecord | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const value = (block as JsonRecord).text;
      return typeof value === 'string' ? value : '';
    })
    .filter(Boolean)
    .join('\n');
}

function requireOutput(
  harness: HeadlessHarnessId,
  sessionId: string | null,
  finalText: string | null,
): { sessionId: string; finalText: string } {
  if (!sessionId) throw new Error(`${harness} completed without a session ID`);
  if (finalText === null) {
    throw new Error(`${harness} completed without a final agent message`);
  }
  return { sessionId, finalText };
}

function claudeCommand(args: HeadlessHarnessTurnArgs): string[] {
  const command = [
    '-p',
    args.prompt,
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--append-system-prompt',
    args.systemPrompt,
  ];
  if (args.sessionId) command.push('--resume', args.sessionId);
  return command;
}

function parseClaudeOutput(
  raw: string,
  existingSessionId?: string,
): { sessionId: string; finalText: string } {
  const record = parseJsonObject(raw, 'claude');
  return requireOutput(
    'claude',
    stringField(record, 'session_id') ?? existingSessionId ?? null,
    stringField(record, 'result'),
  );
}

function codexCommand(args: HeadlessHarnessTurnArgs): string[] {
  const common = [
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--config',
    `developer_instructions=${JSON.stringify(args.systemPrompt)}`,
  ];
  return args.sessionId
    ? ['exec', 'resume', ...common, args.sessionId, args.prompt]
    : ['exec', ...common, args.prompt];
}

function parseCodexOutput(
  raw: string,
  existingSessionId?: string,
): { sessionId: string; finalText: string } {
  const records = parseJsonLines(raw, 'codex');
  const started = records.find((record) => record.type === 'thread.started');
  const failed = records.findLast(
    (record) => record.type === 'turn.failed' || record.type === 'error',
  );
  if (failed) {
    const detail = stringField(failed, 'message') ?? JSON.stringify(failed);
    throw new Error(`codex turn failed: ${detail}`);
  }

  let finalText: string | null = null;
  for (const record of records) {
    if (record.type !== 'item.completed') continue;
    const item = record.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const itemRecord = item as JsonRecord;
    if (itemRecord.type === 'agent_message') {
      finalText = stringField(itemRecord, 'text');
    }
  }
  return requireOutput(
    'codex',
    stringField(started, 'thread_id') ?? existingSessionId ?? null,
    finalText,
  );
}

function piCommand(args: HeadlessHarnessTurnArgs, sessionId: string): string[] {
  return [
    '--print',
    '--mode',
    'json',
    '--session-id',
    sessionId,
    '--approve',
    '--append-system-prompt',
    args.systemPrompt,
    args.prompt,
  ];
}

function parsePiOutput(
  raw: string,
  expectedSessionId: string,
): { sessionId: string; finalText: string } {
  const records = parseJsonLines(raw, 'pi');
  const header = records.find((record) => record.type === 'session');
  let finalText: string | null = null;
  for (const record of records) {
    if (record.type !== 'message_end') continue;
    const message = record.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const messageRecord = message as JsonRecord;
    if (messageRecord.role !== 'assistant') continue;
    const stopReason = stringField(messageRecord, 'stopReason');
    if (stopReason === 'error' || stopReason === 'aborted') {
      throw new Error(
        `pi turn ${stopReason}: ${stringField(messageRecord, 'errorMessage') ?? 'unknown error'}`,
      );
    }
    finalText = contentText(messageRecord.content);
  }
  return requireOutput(
    'pi',
    stringField(header, 'id') ?? expectedSessionId,
    finalText,
  );
}

export async function runHeadlessHarnessTurn(
  args: HeadlessHarnessTurnArgs,
  deps: HeadlessHarnessDeps = {},
): Promise<HeadlessHarnessTurnResult> {
  const commandRunner = deps.commandRunner ?? runCommand;
  const piSessionId =
    args.harness === 'pi'
      ? (args.sessionId ?? deps.sessionIdFactory?.() ?? crypto.randomUUID())
      : null;
  const commandArgs =
    args.harness === 'claude'
      ? claudeCommand(args)
      : args.harness === 'codex'
        ? codexCommand(args)
        : piCommand(args, piSessionId!);

  const startedAt = Date.now();
  console.log(
    `[agent-comms] spawning ${args.harness} ${args.sessionId ? `resume=${args.sessionId.slice(0, 8)}` : '(new session)'} cwd=${args.cwd} msg-len=${args.prompt.length}`,
  );
  const result = await commandRunner({
    command: args.harness,
    args: commandArgs,
    cwd: args.cwd,
    signal: args.signal,
  });
  if (result.exitCode !== 0 || result.killed) {
    return {
      ...result,
      finalText: '',
      sessionId: args.sessionId ?? piSessionId,
    };
  }

  const parsed =
    args.harness === 'claude'
      ? parseClaudeOutput(result.stdout, args.sessionId)
      : args.harness === 'codex'
        ? parseCodexOutput(result.stdout, args.sessionId)
        : parsePiOutput(result.stdout, piSessionId!);
  const durationMs = Date.now() - startedAt;
  console.log(
    `[agent-comms] ${args.harness} exited code=${result.exitCode} duration=${(durationMs / 1000).toFixed(1)}s session=${parsed.sessionId.slice(0, 8)}`,
  );
  return { ...result, ...parsed };
}

