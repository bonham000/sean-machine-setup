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
        const csi = remainder.match(/^\u001b\[([0-9;?]*)([ -/]*)([@-~])/);
        if (!csi) {
          if (remainder.length < 3) this.pending = remainder;
          index += remainder.length < 3 ? remainder.length : 1;
          continue;
        }
        index += csi[0].length;
        const parameters = csi[1] ?? "";
        const final = csi[3];
        if (final === "~" && parameters === "200") this.bracketedPaste = true;
        else if (final === "~" && parameters === "201") this.bracketedPaste = false;
        else if (final === "u") {
          const [code, modifier = "1"] = parameters.split(";");
          if (code === "13") {
            if (modifier === "1") return this.finish();
            this.buffer += "\n";
          } else if (code === "127") {
            this.backspace();
          }
        }
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
