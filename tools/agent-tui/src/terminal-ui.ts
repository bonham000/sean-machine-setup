export type TerminalRole = "title" | "section" | "strong" | "muted" | "accent" | "info" | "success" | "warning" | "error";

const THEME = {
  reset: "\u001b[0m",
  title: "\u001b[1;38;5;141m",
  section: "\u001b[1;38;5;75m",
  strong: "\u001b[1;38;5;78m",
  muted: "\u001b[2m",
  accent: "\u001b[1;38;5;105m",
  info: "\u001b[38;5;75m",
  success: "\u001b[32m",
  warning: "\u001b[33m",
  error: "\u001b[38;5;168m",
} satisfies Record<"reset" | TerminalRole, string>;

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function shouldUseColor(): boolean {
  return process.env.NO_COLOR == null && (Boolean(process.stdout.isTTY) || (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== "0"));
}

export function style(value: string, role: TerminalRole): string {
  if (!shouldUseColor() || !value) return value;
  return `${THEME[role]}${value}${THEME.reset}`;
}

export function visibleLength(value: string): number {
  return Array.from(value.replace(ANSI_PATTERN, "")).length;
}

export function truncateTerminalText(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  if (maxLength <= 3) return ".".repeat(maxLength);
  return `${characters.slice(0, maxLength - 3).join("").trimEnd()}...`;
}

export const terminal = {
  title: (value: string) => style(value, "title"),
  section: (value: string) => style(value, "section"),
  strong: (value: string) => style(value, "strong"),
  muted: (value: string) => style(value, "muted"),
  accent: (value: string) => style(value, "accent"),
  info: (value: string) => style(value, "info"),
  success: (value: string) => style(value, "success"),
  warning: (value: string) => style(value, "warning"),
  error: (value: string) => style(value, "error"),
  cursor: (selected: boolean) => (selected ? style("❯", "info") : " "),
  truncate: truncateTerminalText,
  clearScreen: "\u001b[2J\u001b[H",
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
};

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function fuzzyScore(value: string, query: string): number | null {
  const target = normalizeSearchText(value);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;
  const substring = target.indexOf(normalizedQuery);
  if (substring !== -1) return substring * 4 + target.length - normalizedQuery.length;

  let targetIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gaps = 0;
  for (const character of normalizedQuery) {
    const match = target.indexOf(character, targetIndex);
    if (match === -1) return null;
    if (firstMatch === -1) firstMatch = match;
    if (previousMatch !== -1) gaps += match - previousMatch - 1;
    previousMatch = match;
    targetIndex = match + 1;
  }
  return 100 + firstMatch * 4 + gaps * 3 + target.length - normalizedQuery.length;
}

export function splitInputKeys(chunk: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    const escapeSequence = chunk.slice(index, index + 3);
    if (escapeSequence === "\u001b[A" || escapeSequence === "\u001b[B") {
      keys.push(escapeSequence);
      index += 3;
      continue;
    }
    const codePoint = chunk.codePointAt(index);
    if (codePoint === undefined) break;
    const key = String.fromCodePoint(codePoint);
    keys.push(key);
    index += key.length;
  }
  return keys;
}

export function readTerminalInput(): Promise<string> {
  return new Promise((resolveInput) => {
    const handler = (chunk: Buffer | string): void => {
      process.stdin.off("data", handler);
      resolveInput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    process.stdin.on("data", handler);
  });
}
