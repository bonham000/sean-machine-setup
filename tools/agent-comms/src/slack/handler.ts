/**
 * Strict @-mention harness selector.
 *
 * The root mention creates a daemon-owned attachment but does not start a
 * harness turn. The first ordinary reply in that Slack thread becomes the
 * first prompt and follows the same serialized path as every later reply.
 */

import {
  HEADLESS_HARNESS_IDS,
  HEADLESS_HARNESS_LABELS,
  type HeadlessHarnessId,
  normalizeHeadlessHarnessId,
  preflightHeadlessHarness,
} from '../headless/harness';
import type { DurableRegistry } from '../registry';
import type { SlackPoster } from './types';

export interface ParsedMentionCommand {
  harness: HeadlessHarnessId;
}

export function parseMentionCommand(text: string): ParsedMentionCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const harness = normalizeHeadlessHarnessId(tokens[0]!);
  // `claude-code` remains a stored-runtime compatibility alias, not a public
  // invocation identifier.
  if (!harness || tokens[0]!.toLowerCase() !== harness) return null;
  return { harness };
}

export function mentionHelpText(mention = '@app'): string {
  const ids = HEADLESS_HARNESS_IDS.map((id) => `\`${id}\``).join(', ');
  return `I couldn't start a session. Valid agent identifiers: ${ids}. Try again with ${mention} followed by exactly one identifier, for example: ${mention} \`codex\`.`;
}

export interface HandleHarnessMentionArgs {
  mentionTs: string;
  channel: string;
  harness: HeadlessHarnessId;
  cwd: string;
  machineId: string;
  registry: DurableRegistry;
  poster: SlackPoster;
  /** Test seam; production verifies that the selected CLI launches. */
  preflight?: typeof preflightHeadlessHarness;
}

export async function handleHarnessMention(
  args: HandleHarnessMentionArgs,
): Promise<void> {
  const label = HEADLESS_HARNESS_LABELS[args.harness];
  try {
    await (args.preflight ?? preflightHeadlessHarness)(args.harness, args.cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await args.poster.postThreadMessage({
      channel: args.channel,
      threadTs: args.mentionTs,
      text: `⚠️ ${label} is not ready on ${args.machineId}: ${detail}`,
    });
    return;
  }

  args.registry.createOrReuseAttachment({
    channelId: args.channel,
    threadTs: args.mentionTs,
    cwd: args.cwd,
    machineId: args.machineId,
    agentRuntime: args.harness,
    ownerMode: 'daemon-spawned',
    deliveryAdapter: 'daemon-worker',
  });

  await args.poster.postThreadMessage({
    channel: args.channel,
    threadTs: args.mentionTs,
    text: `\`${args.harness}\` is ready, reply to begin.`,
  });
}
