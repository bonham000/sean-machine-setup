export type SessionStatus = "starting" | "running" | "ended" | "failed";

export type SessionRecord = {
  id: string;
  name: string;
  harness: string;
  command: string;
  args: string[];
  cwd: string;
  repoRoot: string;
  repoName: string;
  firstPrompt: string | null;
  status: SessionStatus;
  daemonPid: number | null;
  childPid: number | null;
  socketPath: string;
  logPath: string;
  daemonLogPath: string;
  createdAt: string;
  updatedAt: string;
  exitCode: number | null;
  signal: number | null;
};

export type ClientRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "attach"; cols: number; rows: number }
  | { id: string; type: "input"; data: string }
  | { id: string; type: "resize"; cols: number; rows: number }
  | { id: string; type: "send"; text: string; submit: boolean }
  | { id: string; type: "stop" };

export type ClientRequestInput =
  | { type: "ping" }
  | { type: "attach"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "send"; text: string; submit: boolean }
  | { type: "stop" };

export type ServerMessage =
  | { type: "response"; id: string; ok: boolean; error?: string; session?: SessionRecord }
  | { type: "output"; data: string; replay?: boolean }
  | { type: "exit"; exitCode: number; signal: number | null };

export type SlackInbound = {
  ts: string;
  userId: string;
  text: string;
};

export type SlackBinding = {
  sessionId: string;
  status: "starting" | "running" | "stopped" | "failed";
  bridgePid: number | null;
  channelId: string;
  threadTs: string;
  threadUrl: string;
  botUserId: string;
  lastSeenTs: string;
  eventOffset: number;
  queue: SlackInbound[];
  active: SlackInbound | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};
