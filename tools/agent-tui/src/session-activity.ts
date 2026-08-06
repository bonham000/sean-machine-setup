import { statSync } from "node:fs";
import { sessionEventsPath } from "./paths.ts";
import { isTerminalAttached } from "./presence.ts";
import type { SessionRecord } from "./types.ts";

export type SessionActivity = "attached" | "working" | "idle";

// A turn is bounded by two edges already present on disk: the daemon appends
// every PTY byte to the session log, and the harness completion hooks append
// agent-turn-complete to the events file. Output newer than the last completion
// therefore means a turn is still in flight, which stays true through a long
// tool call that produces no output at all.
//
// The falling edge needs slack: the hook fires at the end of the turn, but the
// harness keeps painting its final message and redrawing its prompt for a
// moment afterwards. Comparing the raw timestamps would let that trailing
// repaint look like new work and latch a finished session into "working"
// permanently.
export const COMPLETION_GRACE_MS = 1_500;

// Kimi ships no completion hook, and no harness has an events file before its
// first turn ends, so those sessions have no falling edge to latch against.
// Recent output is the only signal left; a silent tool call reads as idle.
export const OUTPUT_QUIET_MS = 2_500;

export type ActivityInput = {
  attached: boolean;
  outputAt: number | null;
  completedAt: number | null;
  now: number;
};

export function classifyActivity({ attached, outputAt, completedAt, now }: ActivityInput): SessionActivity {
  // Local keystrokes echo through the PTY, so an attached session would report
  // working whenever its owner types. The status only informs sessions nobody
  // is currently watching.
  if (attached) return "attached";
  if (outputAt === null) return "idle";
  if (completedAt === null) return now - outputAt < OUTPUT_QUIET_MS ? "working" : "idle";
  return outputAt > completedAt + COMPLETION_GRACE_MS ? "working" : "idle";
}

function modifiedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function sessionActivity(session: SessionRecord, now = Date.now()): SessionActivity {
  return classifyActivity({
    attached: isTerminalAttached(session.id),
    outputAt: modifiedAt(session.logPath),
    completedAt: modifiedAt(sessionEventsPath(session.id)),
    now,
  });
}
