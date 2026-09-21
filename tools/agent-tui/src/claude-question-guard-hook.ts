#!/usr/bin/env bun

import { isTerminalAttached } from "./presence";

// AskUserQuestion opens a dialog that only a keypress in the terminal can
// answer. While the session is detached the user is reachable only through
// Slack, where the dialog is invisible: the turn never ends, no completion is
// relayed, and the session sits blocked until someone reattaches.
//
// A one-time injected instruction would be advisory and would be lost to
// context compaction. Denying the call is enforced on every attempt, and the
// denial reason reaches the model exactly when it needs redirecting. With a
// terminal attached the hook stays silent, so the dialog works as normal.
//
// stdin is deliberately never read: the decision needs only the session
// identity, and a blocking read would hold the turn open (see
// claude-completion-hook.ts).
const DENIAL_REASON = [
  "The user is detached from this terminal and reachable only through Slack, so this dialog cannot be answered and would block the session indefinitely.",
  "Do not retry this tool or any other blocking prompt.",
  "Make the most reasonable decision yourself, note the assumption in your response, and keep working.",
  "If the work truly cannot proceed without the user's input, finish everything that does not depend on it, then end your turn with the question as plain text; it is relayed to Slack and the reply arrives as your next message.",
].join(" ");

const sessionId = process.env.AGENT_TUI_SESSION_ID;
try {
  if (sessionId && !isTerminalAttached(sessionId)) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DENIAL_REASON,
        },
      }),
    );
  }
} catch {
  // A guard failure must never disrupt the Claude Code session.
}

process.exit(0);
