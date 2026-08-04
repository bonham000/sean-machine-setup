import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_COMPLETION_HOOK_PATH = resolve(HERE, "claude-completion-hook.ts");
const CODEX_NOTIFY_PATH = resolve(HERE, "codex-notify.ts");
const PI_COMPLETION_EXTENSION_PATH = resolve(HERE, "pi-completion-extension.ts");
const CLAUDE_FULL_ACCESS_FLAG = "--dangerously-skip-permissions";
const CODEX_FULL_ACCESS_FLAG = "--dangerously-bypass-approvals-and-sandbox";
const KIMI_AUTO_FLAG = "--auto";

export type HarnessDefinition = {
  id: string;
  label: string;
  command: string;
};

export const HARNESSES: readonly HarnessDefinition[] = [
  { id: "codex", label: "Codex", command: "codex" },
  { id: "kimi", label: "Kimi", command: "kimi" },
  { id: "pi", label: "Pi", command: "pi" },
  { id: "claude", label: "Claude Code", command: "claude" },
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
      const fullAccess = args.includes(CLAUDE_FULL_ACCESS_FLAG) ? [] : [CLAUDE_FULL_ACCESS_FLAG];
      return [...fullAccess, "--settings", JSON.stringify(settings), ...args];
    }
    case "codex": {
      const notify = `notify=${JSON.stringify([runtime, CODEX_NOTIFY_PATH])}`;
      const fullAccess = args.includes(CODEX_FULL_ACCESS_FLAG) ? [] : [CODEX_FULL_ACCESS_FLAG];
      return [...fullAccess, "--config", notify, ...args];
    }
    case "kimi":
      return args.includes(KIMI_AUTO_FLAG) ? args : [KIMI_AUTO_FLAG, ...args];
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
