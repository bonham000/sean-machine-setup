// Claude Code negotiates the Kitty keyboard protocol with whatever terminal is
// attached, and Ghostty supports it. Once those flags are pushed the harness is
// listening for enter as CSI 13 u; a bare carriage return is not the enter key
// and does nothing at all. A session that has never been attached stays in
// legacy mode, which is why a detached-only session submits fine on a carriage
// return and the same session submits nothing after someone attaches to it once.
//
// The child announces every one of these transitions in its own output — push
// as CSI > flags u, pop as CSI < u — so the daemon can read the current mode
// off the stream rather than guessing which encoding to send.
const KEYBOARD_MODE = /\u001b\[([<>=])([0-9;]*)u/g;

// Long enough to hold a split escape sequence across a chunk boundary, short
// enough that a stray ESC never pins arbitrary output in memory.
const MAX_PENDING = 24;

// A harness that pushes without popping would otherwise grow this forever.
const MAX_DEPTH = 64;

export class KeyboardModeTracker {
  stack: number[] = [];
  pending = "";

  consume(chunk: string): void {
    const text = this.pending + chunk;
    let consumedTo = 0;
    KEYBOARD_MODE.lastIndex = 0;
    for (let match = KEYBOARD_MODE.exec(text); match; match = KEYBOARD_MODE.exec(text)) {
      consumedTo = match.index + match[0].length;
      this.apply(match[1]!, match[2]!);
    }
    const rest = text.slice(consumedTo);
    const escape = rest.lastIndexOf("\u001b");
    const tail = escape < 0 ? "" : rest.slice(escape);
    this.pending = tail.length <= MAX_PENDING ? tail : "";
  }

  apply(kind: string, params: string): void {
    const value = Number.parseInt(params.split(";")[0] ?? "", 10);
    if (kind === ">") {
      if (this.stack.length < MAX_DEPTH) this.stack.push(Number.isNaN(value) ? 1 : value);
      return;
    }
    if (kind === "<") {
      const count = Number.isNaN(value) ? 1 : Math.max(1, value);
      this.stack.length = Math.max(0, this.stack.length - count);
      return;
    }
    const flags = Number.isNaN(value) ? 0 : value;
    if (this.stack.length === 0) this.stack.push(flags);
    else this.stack[this.stack.length - 1] = flags;
  }

  // Any non-zero flag set means the harness has moved off legacy key reporting.
  get kittyKeyboardActive(): boolean {
    return (this.stack[this.stack.length - 1] ?? 0) > 0;
  }
}
