import type { SlackPoster, SlackReactor } from '../../src/slack/types';

export interface PostedMessage {
  channel: string;
  threadTs?: string;
  text: string;
}

/**
 * Minimal recording SlackPoster for suites that only care about thread
 * messages (heartbeat, error-watchdog). Unlike createFakeSlackClient,
 * postOpener is NOT recorded, so `posts` counts thread messages only.
 */
export function makePoster(): { poster: SlackPoster; posts: PostedMessage[] } {
  const posts: PostedMessage[] = [];
  const poster: SlackPoster = {
    async postOpener() {
      return { ts: '0' };
    },
    async postThreadMessage(params) {
      posts.push({
        channel: params.channel,
        threadTs: params.threadTs,
        text: params.text,
      });
      return { ts: String(posts.length) };
    },
  };
  return { poster, posts };
}

export interface AddedReaction {
  channel: string;
  timestamp: string;
  name: string;
}

export interface FakeSlackClient extends SlackPoster, SlackReactor {
  /** All messages posted (opener + thread replies). */
  posted: PostedMessage[];
  /** All reactions added. */
  reactions: AddedReaction[];
  /** Reset state between tests. */
  reset(): void;
  /** Assert a posted message matching partial fields. Throws if not found. */
  assertPosted(partial: Partial<PostedMessage>): void;
  /** Assert a reaction matching partial fields. Throws if not found. */
  assertReacted(partial: Partial<AddedReaction>): void;
}

export function createFakeSlackClient(opts?: {
  tsCounter?: { value: number };
}): FakeSlackClient {
  const counter = opts?.tsCounter ?? { value: 1 };

  const client: FakeSlackClient = {
    posted: [],
    reactions: [],

    reset() {
      client.posted = [];
      client.reactions = [];
    },

    async postOpener(params) {
      const ts = String(counter.value++);
      client.posted.push({ channel: params.channel, text: params.text });
      return { ts };
    },

    async postThreadMessage(params) {
      const ts = String(counter.value++);
      client.posted.push({
        channel: params.channel,
        threadTs: params.threadTs,
        text: params.text,
      });
      return { ts };
    },

    async addReaction(params) {
      client.reactions.push({
        channel: params.channel,
        timestamp: params.timestamp,
        name: params.name,
      });
    },

    assertPosted(partial) {
      const found = client.posted.some((m) =>
        Object.entries(partial).every(
          ([k, v]) => m[k as keyof PostedMessage] === v,
        ),
      );
      if (!found) {
        throw new Error(
          `Expected posted message matching ${JSON.stringify(partial)} but got:\n${JSON.stringify(client.posted, null, 2)}`,
        );
      }
    },

    assertReacted(partial) {
      const found = client.reactions.some((r) =>
        Object.entries(partial).every(
          ([k, v]) => r[k as keyof AddedReaction] === v,
        ),
      );
      if (!found) {
        throw new Error(
          `Expected reaction matching ${JSON.stringify(partial)} but got:\n${JSON.stringify(client.reactions, null, 2)}`,
        );
      }
    },
  };

  return client;
}

