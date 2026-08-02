/** Narrow Slack client interfaces for HTTP routes and test injection. */

export interface SlackPoster {
  /** Post a top-level message (thread opener) to a channel. */
  postOpener(params: {
    channel: string;
    text: string;
  }): Promise<{ ts: string }>;
  /** Post a reply into an existing thread. */
  postThreadMessage(params: {
    channel: string;
    threadTs: string;
    text: string;
  }): Promise<{ ts: string }>;
}

export interface SlackReactor {
  /** Add an emoji reaction to a message. Best-effort — callers should swallow errors. */
  addReaction(params: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<void>;
}

