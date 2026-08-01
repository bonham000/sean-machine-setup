import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface PiMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface PiExtensionApi {
  on(event: "agent_end", handler: (event: { messages: PiMessage[] }) => void): void;
  on(event: "agent_settled", handler: () => void): void;
}

export function extractPiAssistantText(messages: PiMessage[]): string | undefined {
  let assistant: PiMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistant = messages[index];
      break;
    }
  }
  if (!assistant) return undefined;
  if (typeof assistant.content === "string") return assistant.content.trim() || undefined;
  const content = assistant.content;
  const text = content
    ?.filter((block: { type?: string; text?: string }) => block.type === "text" && typeof block.text === "string")
    .map((block: { type?: string; text?: string }) => block.text?.trim())
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}

function persistCompletion(text: string): void {
  const sessionId = process.env.AGENT_TUI_SESSION_ID;
  if (!sessionId) return;
  const stateRoot = process.env.AGENT_TUI_HOME ?? join(homedir(), ".local", "state", "agent-tui");
  const sessions = join(stateRoot, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const event = {
    type: "agent-turn-complete",
    harness: "pi",
    "last-assistant-message": text,
  };
  appendFileSync(join(sessions, `${sessionId}.events.jsonl`), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export default function piCompletionExtension(pi: PiExtensionApi): void {
  let pendingCompletion: string | undefined;

  pi.on("agent_end", (event) => {
    pendingCompletion = extractPiAssistantText(event.messages);
  });

  pi.on("agent_settled", () => {
    if (!pendingCompletion) return;
    try {
      persistCompletion(pendingCompletion);
    } catch {
      // Completion reporting must never disrupt the Pi session.
    } finally {
      pendingCompletion = undefined;
    }
  });
}
