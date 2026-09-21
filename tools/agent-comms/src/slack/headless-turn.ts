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

/** Slack code-fence delimiter. */
const BACKTICKS = String.fromCharCode(96, 96, 96);

export const DAEMON_OWNS_SLACK_PROMPT = `The agent-comms daemon will post your final response to Slack. Do not invoke agent-comms messaging commands, task notify, task ask, or any other Slack-posting tool for this response; that would duplicate the message. Produce your final response normally.

Nobody is at a terminal for this session: the user sees only your final response, in Slack. Never use a blocking question or approval tool, and never stop early to check in. Make the most reasonable decision yourself, note the assumption, and keep working. If the work truly cannot proceed without the user's input, finish everything that does not depend on it, then end your response with the question as plain text; the user's Slack reply arrives as your next message.

If you change the agent-comms daemon itself during this turn, NEVER run task agent-comms:install, task agent-comms:restart, launchctl, or an ad-hoc delayed command. As your final tool step, run \`task -d ~/Documents/sean-machine-setup agent-comms:restart-after-reply\`. It validates and stages the build, then asks the parent daemon to exit exactly once only after all active headless turns have posted their final Slack replies.`;

/**
 * Anything in a failure that points at credentials rather than at the work.
 * Worth calling out separately: an auth failure is fixed on the machine, not
 * by rewording the Slack prompt.
 */
const AUTH_FAILURE_PATTERN =
  /oauth|authenticat|credential|api key|unauthorized|session expired|not logged in/i;

/**
 * Render a failed turn for Slack.
 *
 * The old version posted `result.stderr` and nothing else, which is why an
 * expired Claude Code OAuth session surfaced as
 * "claude turn failed (exit 1) (no stderr)" — the reason was on stdout the
 * whole time. `failureDetail` already looked in both streams.
 */
export function formatTurnFailure(
  harness: HeadlessHarnessId,
  result: HeadlessHarnessTurnResult,
): string {
  const detail =
    result.failureDetail?.trim() || '(no output on stdout or stderr)';
  const lines = [
    `⚠️ ${harness} turn failed (exit ${result.exitCode})`,
    [BACKTICKS, detail.slice(0, 800), BACKTICKS].join(String.fromCharCode(10)),
  ];
  if (AUTH_FAILURE_PATTERN.test(detail)) {
    lines.push(
      `_${harness} could not authenticate on this machine. Re-authenticate ` +
        'that CLI there, then reply again to retry — the thread and its ' +
        'session binding stay valid._',
    );
  }
  return lines.join(String.fromCharCode(10));
}

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
        await poster.postThreadMessage({
          channel,
          threadTs,
          text: formatTurnFailure(harness, result),
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
