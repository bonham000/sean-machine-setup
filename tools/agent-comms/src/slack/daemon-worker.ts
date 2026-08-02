/**
 * Per-attachment serial turn worker for daemon-spawned attachments.
 *
 * Daemon-owned sessions never have a terminal harness touching the same
 * session ID. The per-attachment Promise chain keeps two resume invocations
 * from running concurrently against one session.
 */

import { normalizeHeadlessHarnessId } from '../headless/harness';
import type { DurableRegistry } from '../registry';
import { type HeadlessTurnRunner, runHeadlessTurn } from './headless-turn';
import type { SlackPoster } from './types';

export interface DaemonWorker {
  /**
   * Enqueue a turn for (attachmentId, messageId). Fire-and-forget: kick()
   * returns synchronously and the spawn happens on the per-attachment
   * promise chain, so concurrent inbound messages for the same thread
   * process one-after-another.
   */
  kick(params: { attachmentId: string; messageId: string }): void;
  /** Test/shutdown helper: resolves once all in-flight turns settle. */
  drain(): Promise<void>;
}

export interface DaemonWorkerConfig {
  registry: DurableRegistry;
  poster: SlackPoster;
  /** Test seam; production uses the normalized multi-harness runner. */
  turnRunner?: HeadlessTurnRunner;
}

export function createDaemonWorker(config: DaemonWorkerConfig): DaemonWorker {
  const { registry, poster, turnRunner = runHeadlessTurn } = config;
  const serializers = new Map<string, Promise<void>>();

  async function processTurn(
    attachmentId: string,
    messageId: string,
  ): Promise<void> {
    const attachment = registry.getAttachment(attachmentId);
    if (!attachment) {
      console.error(
        `[agent-comms] daemon-worker: attachment ${attachmentId} not found, skipping message ${messageId}`,
      );
      return;
    }
    if (attachment.status === 'ended' || attachment.status === 'errored') {
      console.log(
        `[agent-comms] daemon-worker: attachment ${attachmentId} is ${attachment.status}, marking message ${messageId} failed`,
      );
      registry.markMessageFailed({
        messageId,
        error: `attachment ${attachment.status}`,
      });
      return;
    }

    const message = registry.getMessageById(messageId);
    if (!message) {
      console.error(
        `[agent-comms] daemon-worker: message ${messageId} not found`,
      );
      return;
    }
    if (message.status === 'handled') {
      return;
    }

    const isFirstTurn = attachment.session_id === null;
    const harness = normalizeHeadlessHarnessId(attachment.agent_runtime);
    if (!harness) {
      const failureReason = `unsupported harness '${attachment.agent_runtime}'`;
      console.error(
        `[agent-comms] daemon-worker: ${failureReason} attach=${attachmentId}`,
      );
      registry.markMessageFailed({ messageId, error: failureReason });
      if (isFirstTurn) registry.markAttachmentErrored(attachmentId);
      return;
    }

    console.log(
      `[agent-comms] daemon-worker: processing harness=${harness} message=${messageId} attach=${attachmentId} session=${attachment.session_id?.slice(0, 8) ?? '?'}`,
    );

    const outcome = await turnRunner({
      poster,
      threadTs: attachment.thread_ts,
      channel: attachment.channel_id,
      harness,
      userText: message.text,
      cwd: attachment.cwd,
      sessionId: attachment.session_id ?? undefined,
    });

    const failureReason: string | null = outcome.thrown
      ? outcome.thrown.message
      : !outcome.result
        ? 'no spawn result'
        : outcome.result.exitCode !== 0
          ? `${harness} exit ${outcome.result.exitCode}`
          : null;

    if (failureReason !== null) {
      registry.markMessageFailed({ messageId, error: failureReason });
      // An attachment with no session ID can never be resumed — if the first
      // turn fails, mark the attachment errored so subsequent replies hit the
      // legacy "previous version" notice instead of silently spawning more
      // fresh harnesses.
      if (isFirstTurn) {
        registry.markAttachmentErrored(attachmentId);
      }
      return;
    }

    const result = outcome.result!;
    // Harnesses keep the same session ID across resume. The inequality guard
    // avoids a write per turn in the steady state.
    if (result.sessionId && result.sessionId !== attachment.session_id) {
      registry.setAttachmentSessionId(attachmentId, result.sessionId);
    }

    registry.markMessageHandled({ attachmentId, messageId });
    registry.recordAgentActivity(attachmentId);
  }

  return {
    kick({ attachmentId, messageId }) {
      const prev = serializers.get(attachmentId) ?? Promise.resolve();
      const next = prev
        .then(() => processTurn(attachmentId, messageId))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[agent-comms] daemon-worker: unhandled error attach=${attachmentId} msg=${messageId}: ${msg}`,
          );
        });
      serializers.set(attachmentId, next);
      // Cleanup only if we're still the tail of the chain — a later kick
      // overwrites the map entry to its own promise and is responsible for
      // cleaning up itself.
      next.finally(() => {
        if (serializers.get(attachmentId) === next) {
          serializers.delete(attachmentId);
        }
      });
    },
    async drain() {
      await Promise.all(Array.from(serializers.values()));
    },
  };
}

