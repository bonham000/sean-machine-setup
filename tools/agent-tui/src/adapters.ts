import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_COMPLETION_HOOK_PATH = resolve(HERE, "claude-completion-hook.ts");
const CODEX_NOTIFY_PATH = resolve(HERE, "codex-notify.ts");
const PI_COMPLETION_EXTENSION_PATH = resolve(HERE, "pi-completion-extension.ts");

export type HarnessDefinition = {
  id: string;
  label: string;
  command: string;
};

export const HARNESSES: readonly HarnessDefinition[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "pi", label: "Pi", command: "pi" },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function commandArgsWithAdapters(command: string, args: string[], runtime = process.execPath): string[] {
  switch (basename(command)) {
    case "claude": {
      const settings = {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${shellQuote(runtime)} ${shellQuote(CLAUDE_COMPLETION_HOOK_PATH)}`,
                },
              ],
            },
          ],
        },
      };
      return ["--settings", JSON.stringify(settings), ...args];
    }
    case "codex": {
      const notify = `notify=${JSON.stringify([runtime, CODEX_NOTIFY_PATH])}`;
      return ["--config", notify, ...args];
    }
    case "pi":
      return ["--extension", PI_COMPLETION_EXTENSION_PATH, ...args];
    default:
      return args;
  }
}

export function harnessForCommand(command: string): HarnessDefinition | undefined {
  const executable = basename(command);
  return HARNESSES.find((harness) => harness.command === executable);
}
