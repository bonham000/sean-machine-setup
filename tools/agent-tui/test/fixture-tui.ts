#!/usr/bin/env bun

if (!process.stdin.isTTY) throw new Error("fixture requires a TTY");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\u001b[?2004hREADY\r\n> ");

let input = "";
let pasting = false;

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
    const character = text[index]!;
    if (!pasting && (character === "\r" || character === "\n")) {
      process.stdout.write(`\r\nRECEIVED:${JSON.stringify(input)}\r\n> `);
      input = "";
      continue;
    }
    if (character === "\u0004") process.exit(0);
    input += character;
  }
});
