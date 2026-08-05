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

export function terminalPaste(text: string, submit: boolean): string {
  const sanitized = sanitizePasteText(text);
  return `\u001b[200~${sanitized}\u001b[201~${submit ? "\r" : ""}`;
}

export function terminalReplacementPaste(text: string, submit: boolean): string {
  return `\u0015${terminalPaste(text, submit)}`;
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
