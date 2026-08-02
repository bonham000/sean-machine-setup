import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionRecord } from "./types";

const STORED_PROMPT_LIMIT = 240;
const LABEL_PROMPT_LIMIT = 56;

export async function findRepository(start: string): Promise<{ root: string; name: string }> {
  let current = resolve(start);
  while (true) {
    try {
      await stat(join(current, ".git"));
      return { root: current, name: basename(current) || "root" };
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return { root: resolve(start), name: basename(resolve(start)) || "root" };
    current = parent;
  }
}

export function normalizeFirstPrompt(value: string): string | null {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, STORED_PROMPT_LIMIT).join("");
}

export function withFirstPrompt(record: SessionRecord, value: string): SessionRecord {
  if (record.firstPrompt) return record;
  const firstPrompt = normalizeFirstPrompt(value);
  if (!firstPrompt) return record;
  return { ...record, firstPrompt, updatedAt: new Date().toISOString() };
}

function truncatePrompt(value: string, limit = LABEL_PROMPT_LIMIT): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, Math.max(0, limit - 3)).join("").trimEnd()}...`;
}

function sameCalendarDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function humanSessionStart(value: string, now = new Date()): string {
  const started = new Date(value);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(started);
  if (sameCalendarDay(started, now)) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameCalendarDay(started, yesterday)) return `Yesterday ${time}`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(started);
}

export function sessionLabel(record: SessionRecord, now = new Date()): string {
  const repo = normalizeFirstPrompt(record.repoName || basename(record.repoRoot || record.cwd) || "root") || "root";
  const harness = normalizeFirstPrompt(record.harness || basename(record.command)) || "agent";
  const prompt = truncatePrompt(record.firstPrompt || "Waiting for first prompt...");
  return `[${repo}] [${harness}] [${humanSessionStart(record.createdAt, now)}] • ${prompt}`;
}

export class FirstPromptCapture {
  private buffer = "";
  private pending = "";
  private bracketedPaste = false;

  consume(chunk: string): string | null {
    let input = this.pending + chunk;
    this.pending = "";
    let index = 0;

    while (index < input.length) {
      if (input[index] === "\u001b") {
        const remainder = input.slice(index);
        if (remainder.startsWith("\u001b[")) {
          const csi = remainder.match(/^\u001b\[([0-?]*)([ -/]*)([@-~])/);
          if (!csi) {
            if (!remainder.slice(2).match(/[@-~]/)) {
              this.pending = remainder;
              break;
            }
            index += 2;
            continue;
          }
          index += csi[0].length;
          const result = this.consumeCsi(csi[1] ?? "", csi[3] ?? "");
          if (result) return result;
          continue;
        }

        if (
          remainder.startsWith("\u001b]") ||
          remainder.startsWith("\u001bP") ||
          remainder.startsWith("\u001b^") ||
          remainder.startsWith("\u001b_")
        ) {
          const allowBell = remainder[1] === "]";
          let end = -1;
          for (let cursor = 2; cursor < remainder.length; cursor += 1) {
            if (allowBell && remainder[cursor] === "\u0007") {
              end = cursor + 1;
              break;
            }
            if (remainder[cursor] === "\u001b" && remainder[cursor + 1] === "\\") {
              end = cursor + 2;
              break;
            }
          }
          if (end < 0) {
            this.pending = remainder;
            break;
          }
          index += end;
          continue;
        }

        if (remainder.startsWith("\u001bO")) {
          if (remainder.length < 3) {
            this.pending = remainder;
            break;
          }
          index += 3;
          continue;
        }

        if (remainder.length === 1) {
          this.pending = remainder;
          break;
        }
        index += 2;
        continue;
      }

      const codePoint = input.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      index += character.length;
      if (character === "\r" || character === "\n") {
        if (!this.bracketedPaste) return this.finish();
        this.buffer += "\n";
      } else if (character === "\u007f" || character === "\b") {
        this.backspace();
      } else if (character === "\u0015") {
        this.buffer = "";
      } else if (codePoint >= 0x20) {
        this.buffer += character;
      }
    }
    return null;
  }

  private consumeCsi(parameters: string, final: string): string | null {
    if (final === "~" && parameters === "200") {
      this.bracketedPaste = true;
      return null;
    }
    if (final === "~" && parameters === "201") {
      this.bracketedPaste = false;
      return null;
    }
    if (final !== "u") return null;

    const [keyField = "", modifierField = "1", textField] = parameters.split(";");
    const eventType = modifierField.split(":")[1] ?? "1";
    if (eventType === "3") return null;

    const keyCode = Number(keyField.split(":")[0]);
    if (keyCode === 13) {
      if (this.bracketedPaste) {
        this.buffer += "\n";
        return null;
      }
      return this.finish();
    }
    if (keyCode === 127 || keyCode === 8) {
      this.backspace();
      return null;
    }

    const modifiers = Math.max(0, Number(modifierField.split(":")[0]) - 1);
    const hasCommandModifier = (modifiers & (2 | 4 | 8 | 16 | 32)) !== 0;
    if (hasCommandModifier) return null;

    const textCodes = (textField ? textField.split(":") : [keyField.split(":")[0] ?? ""])
      .map(Number)
      .filter((code) => Number.isInteger(code) && code >= 0x20 && code <= 0x10ffff && !(code >= 0xe000 && code <= 0xf8ff));
    for (const code of textCodes) this.buffer += String.fromCodePoint(code);
    return null;
  }

  private backspace(): void {
    const characters = Array.from(this.buffer);
    characters.pop();
    this.buffer = characters.join("");
  }

  private finish(): string | null {
    const prompt = normalizeFirstPrompt(this.buffer);
    this.buffer = "";
    return prompt;
  }
}
