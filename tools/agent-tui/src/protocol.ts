import type { Socket } from "node:net";

const DETACH_SEQUENCES: Array<{ bytes: Buffer; action: "detach" | "slack" }> = [
  { bytes: Buffer.from([0x1d]), action: "detach" }, // Ctrl-]
  { bytes: Buffer.from([0x1c]), action: "detach" }, // Ctrl-\\
  { bytes: Buffer.from("\u001b[99~"), action: "slack" }, // Priori Ghostty Cmd-L binding
];

// A full-screen child changes modes on the outer terminal through its rendered
// output. Detaching severs the child before it can undo those modes itself.
export const OUTER_TERMINAL_RESTORE = [
  "\u001b[?2026l", // end synchronized output
  "\u001b[<1u", // pop Kitty keyboard-protocol flags
  "\u001b[>4;0m", // disable xterm modifyOtherKeys
  "\u001b[?2004l", // disable bracketed paste
  "\u001b[?1004l", // disable focus reporting
  "\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l", // disable mouse reporting
  "\u001b[?1l\u001b>", // restore normal cursor keys and keypad
  "\u001b[?1049l", // return from the alternate screen
  "\u001b[0m\u001b[?25h", // reset styling and show the cursor
  "\r\u001b[2K", // clear any partial child output on the restored line
].join("");

export function writeMessage(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

export function readJsonLines<T>(onValue: (value: T) => void): (chunk: Buffer) => void {
  let buffered = "";
  return (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      onValue(JSON.parse(line) as T);
    }
  };
}

export function sanitizePasteText(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let result = "";
  for (const character of normalized) {
    const code = character.codePointAt(0)!;
    if (character === "\n" || character === "\t" || (code >= 0x20 && code !== 0x7f)) {
      result += character;
    }
  }
  return result;
}

export const SUBMIT_KEY = "\r";

// A harness does not necessarily commit a bracketed paste the moment it reads
// the closing marker. Claude Code holds a large paste back as a deferred
// attachment ("[Pasted text #1 +10 lines]") and finalizes it a tick later, so a
// carriage return arriving in that same PTY read is absorbed into the paste
// instead of submitting it. The message then sits unsent in the composer with
// nothing to show it was ever delivered; the sender only finds out by
// reattaching. Writing the submit key separately puts it in its own read, once
// the harness has committed the paste.
// The harness has to have committed and painted the paste before the enter key
// means anything. Rather than guess how long that takes in a session with a
// large context, wait for its output to go quiet — then fall back to sending
// anyway, because a harness that never stops painting must not block delivery.
// How long to give the harness to show any sign of the paste. A harness that
// renders nothing at all must not pay the full settle budget on every message.
export const PASTE_REACTION_MAX_MS = 600;
export const PASTE_SETTLE_QUIET_MS = 250;
export const PASTE_SETTLE_MAX_MS = 3_000;

// A dropped submit key is otherwise unrecoverable: the message sits in the
// composer looking delivered while the sender waits for a reply that no one is
// writing. Long enough after the submit that an accepted one has certainly
// repainted the screen.
// Accepting a submit is never silent: the harness clears its composer and
// starts painting the turn. Silence this long after the key means it was not
// the key the harness was listening for.
export const SUBMIT_RETRY_MS = 700;

// Claude Code drives its input through the Kitty keyboard protocol, where enter
// is reported as this sequence rather than a bare carriage return; the prompt
// capture in session-metadata already has to understand it. Which encoding the
// harness is listening for depends on the mode it currently has pushed, so a
// submit that produced no reaction at all is retried in the other one.
export const KITTY_SUBMIT_KEY = "\u001b[13u";

export function terminalPaste(text: string): string {
  return `\u001b[200~${sanitizePasteText(text)}\u001b[201~`;
}

export function terminalReplacementPaste(text: string): string {
  return `\u0015${terminalPaste(text)}`;
}

export function findDetachSequence(input: Buffer): { index: number; action: "detach" | "slack" } | null {
  let found: { index: number; action: "detach" | "slack" } | null = null;
  for (const sequence of DETACH_SEQUENCES) {
    const index = input.indexOf(sequence.bytes);
    if (index >= 0 && (!found || index < found.index)) found = { index, action: sequence.action };
  }
  return found;
}

export function detachSequenceIndex(input: Buffer): number {
  return findDetachSequence(input)?.index ?? -1;
}
