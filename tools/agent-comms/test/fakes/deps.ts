/**
 * Shared test plumbing for HTTP-route and CLI suites.
 *
 * Keeps the copy-pasted helpers (thread URL builder, no-op ask registry,
 * ServerDeps factory, polling waiter, JSON POST helper) in one place.
 * Slack-specific fakes live in ./slack.
 */

import type { AskRegistry } from '../../src/asks';
import type { ServerDeps } from '../../src/http/server';
import type { DurableRegistry } from '../../src/registry';
import type { SlackPoster } from '../../src/slack/types';

/** Deterministic thread URL builder used by route deps in tests. */
export function makeThreadUrl(channel: string, ts: string): string {
  return `https://slack.com/archives/${channel}/p${ts}`;
}

/** No-op AskRegistry for suites that never exercise the ask flow. */
export function makeNoopAskRegistry(): AskRegistry {
  return {
    reserve: () => ({ ok: false, error: 'already_pending' }),
    resolve: () => false,
    hasPending: () => false,
    cancel: () => {},
    shutdownAll: () => {},
  };
}

/**
 * Build a full ServerDeps for createHttpApp with test-friendly defaults
 * (short long-poll timeout, no-op ask registry, deterministic thread URLs).
 * Pass `channelId` (and anything else) via overrides.
 */
export function makeServerDeps(
  registry: DurableRegistry,
  poster: SlackPoster,
  overrides: Partial<ServerDeps> = {},
): ServerDeps {
  return {
    channelId: 'C_TEST',
    machineId: 'test-machine',
    registry,
    poster,
    threadUrl: makeThreadUrl,
    discoverSession: () => null,
    askRegistry: makeNoopAskRegistry(),
    isSlackConnected: () => true,
    // Short long-poll timeout so tests don't take 25s each
    longPollTimeoutMs: 100,
    ...overrides,
  };
}

/** Wait for a condition to become truthy, polling every 20ms up to timeoutMs. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** POST a JSON body to an in-process Hono route. */
export async function postJson(
  route: { fetch: (req: Request) => Response | Promise<Response> },
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return route.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  );
}

