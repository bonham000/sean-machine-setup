/** Spawn one daemon-owned harness turn and post its final response to Slack. */

import {
  type HeadlessHarnessId,
  type HeadlessHarnessTurnResult,
  runHeadlessHarnessTurn,
} from '../headless/harness';
import { toSlackMrkdwn } from './formatter';
import { DEFAULT_POST_INTERVAL_MS } from './heartbeat';
import { AGENT_COMMS_SYSTEM_PROMPT } from './system-prompt';
import type { SlackPoster } from './types';

const PLACEHOLDER_TEXT = '_thinking..._';

export const DAEMON_OWNS_SLACK_PROMPT = `The agent-comms daemon will post your final response to Slack. Do not invoke agent-comms, task notify, task ask, or any other Slack-posting tool for this response; that would duplicate the message. Produce your final response normally.`;

export interface RunHeadlessTurnArgs {
  poster: SlackPoster;
  threadTs: string;
  channel: string;
  harness: HeadlessHarnessId;
  userText: string;
  cwd: string;
  sessionId?: string;
}

export interface RunHeadlessTurnOutcome {
  result: HeadlessHarnessTurnResult | null;
  thrown: Error | null;
}

export type HeadlessTurnRunner = (
  args: RunHeadlessTurnArgs,
) => Promise<RunHeadlessTurnOutcome>;

export type HarnessTurnExecutor = typeof runHeadlessHarnessTurn;

/** Build the Slack-facing runner around an injectable harness executor. */
export function createHeadlessTurnRunner(
  executeHarnessTurn: HarnessTurnExecutor = runHeadlessHarnessTurn,
): HeadlessTurnRunner {
  return async (args) => {
    const { poster, threadTs, channel, harness, userText, cwd, sessionId } =
      args;

    await poster
      .postThreadMessage({ channel, threadTs, text: PLACEHOLDER_TEXT })
      .catch((error: unknown) =>
        console.error(
          `[agent-comms] placeholder post failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
      poster
        .postThreadMessage({
          channel,
          threadTs,
          text: `_still thinking... ${elapsedMin}m_`,
        })
        .catch((error: unknown) =>
          console.error(
            `[agent-comms] heartbeat post failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }, DEFAULT_POST_INTERVAL_MS);

    try {
      const result = await executeHarnessTurn({
        harness,
        prompt: userText,
        sessionId,
        cwd,
        systemPrompt: `${AGENT_COMMS_SYSTEM_PROMPT}\n\n${DAEMON_OWNS_SLACK_PROMPT}`,
      });

      if (result.exitCode === 0) {
        const text = toSlackMrkdwn(
          result.finalText.trim() || '_(empty response)_',
        );
        await poster.postThreadMessage({ channel, threadTs, text });
      } else {
        const stderrSnippet = result.stderr.slice(0, 800);
        await poster.postThreadMessage({
          channel,
          threadTs,
          text: `⚠️ ${harness} turn failed (exit ${result.exitCode})\n\`\`\`${stderrSnippet || '(no stderr)'}\`\`\``,
        });
      }
      return { result, thrown: null };
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      console.error(
        `[agent-comms] ${harness} turn threw: ${normalized.message}`,
      );
      await poster
        .postThreadMessage({
          channel,
          threadTs,
          text: `⚠️ ${harness} turn errored: ${normalized.message}`,
        })
        .catch(() => {
          /* swallow — already in error path */
        });
      return { result: null, thrown: normalized };
    } finally {
      clearInterval(heartbeat);
    }
  };
}

export const runHeadlessTurn = createHeadlessTurnRunner();

