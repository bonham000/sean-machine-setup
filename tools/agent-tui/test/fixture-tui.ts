#!/usr/bin/env bun

if (!process.stdin.isTTY) throw new Error("fixture requires a TTY");
process.stdin.setRawMode(true);
process.stdin.resume();

// Emulates a harness that silently loses a submit key: the paste lands in the
// composer, the enter does nothing, and no output marks the loss.
const dropFirstSubmit = process.env.FIXTURE_DROP_FIRST_SUBMIT === "1";
let droppedSubmit = false;

// Emulates a harness driving the Kitty keyboard protocol, where a bare
// carriage return is not the enter key at all.
const onlyKittySubmit = process.env.FIXTURE_ONLY_KITTY_SUBMIT === "1";

// Whether it announces that mode in its output the way a real harness does.
// Without the announcement the daemon can only find the encoding by trying.
const announceKitty = process.env.FIXTURE_ANNOUNCE_KITTY === "1";

// Emulates a harness that accepts no submit key at all, so delivery genuinely
// cannot be completed and has to be reported rather than assumed.
const ignoreSubmit = process.env.FIXTURE_IGNORE_SUBMIT === "1";

let input = "";
let pasting = false;
let ignoredCarriageReturns = 0;

if (announceKitty) process.stdout.write("\u001b[>1u");
process.stdout.write("\u001b[?2004hREADY\r\n> ");

function submit(by: string): void {
  process.stdout.write(
    `\r\nSUBMITTED-BY:${by} CR-IGNORED:${ignoredCarriageReturns}\r\nRECEIVED:${JSON.stringify(input)}\r\n> `,
  );
  input = "";
}

process.stdin.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith("\u001b[200~", index)) {
      pasting = true;
      index += 5;
      continue;
    }
    if (text.startsWith("\u001b[201~", index)) {
      pasting = false;
      index += 5;
      continue;
    }
    if (text.startsWith("\u001b[13u", index)) {
      if (onlyKittySubmit && !ignoreSubmit) submit("kitty");
      index += 4;
      continue;
    }
    const character = text[index]!;
    if (!pasting && (character === "\r" || character === "\n")) {
      if (ignoreSubmit) continue;
      if (onlyKittySubmit) {
        ignoredCarriageReturns += 1;
        continue;
      }
      if (dropFirstSubmit && !droppedSubmit) {
        droppedSubmit = true;
        continue;
      }
      submit("cr");
      continue;
    }
    if (character === "\u0004") process.exit(0);
    input += character;
  }
});
