import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REMINDER_ENTRY_TYPE = "sleep-reminder";
const REMINDER_TRIGGERED_TYPE = "sleep-reminder-triggered";
const REMINDER_CANCELED_TYPE = "sleep-reminder-canceled";

interface ScheduledReminder {
  id: string;
  message: string;
  triggerAt: number;
  createdAt: number;
  durationMs: number;
}

interface ReminderTimer {
  reminder: ScheduledReminder;
  timeout: ReturnType<typeof setTimeout>;
}

const activeReminders = new Map<string, ReminderTimer>();

function createReminderId(): string {
  return `sleep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseDurationMs(durationText: string): number | null {
  const lower = durationText.trim().toLowerCase();
  const partPattern = /(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|min|hours?|hrs?|h|days?|d)\b/g;

  let match: RegExpExecArray | null;
  let totalMs = 0;
  let parsedAny = false;

  while ((match = partPattern.exec(lower)) !== null) {
    parsedAny = true;
    const value = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    if (Number.isNaN(value) || value <= 0) continue;

    if (unit.startsWith("ms")) {
      totalMs += value;
    } else if (unit.startsWith("sec") || unit === "s" || unit === "secs") {
      totalMs += value * 1000;
    } else if (unit.startsWith("min") || unit === "m" || unit.startsWith("mins") || unit === "min") {
      totalMs += value * 60_000;
    } else if (unit.startsWith("hr") || unit.startsWith("h") || unit.startsWith("hours")) {
      totalMs += value * 60 * 60_000;
    } else if (unit.startsWith("day") || unit === "d") {
      totalMs += value * 24 * 60 * 60_000;
    }
  }

  if (!parsedAny) return null;
  return totalMs > 0 ? Math.floor(totalMs) : null;
}

function parseSleepCommand(input: string): { durationMs: number; message: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withOptionalFor = trimmed.replace(/^for\s+/i, "");
  const match = withOptionalFor.match(
    /^(?:\s*)((?:\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|min|hours?|hrs?|h|days?|d)\s*)+)(?:\s*,?\s*then\s+|\s+)([\s\S]+)$/i,
  );

  if (!match) return null;

  const durationPart = match[1].trim();
  const message = match[2].trim();

  if (!message) return null;

  const durationMs = parseDurationMs(durationPart);
  if (!durationMs) return null;

  return { durationMs, message };
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || (hours > 0 && seconds > 0)) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

function formatTriggerDate(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function coerceReminderData(entryData: unknown): ScheduledReminder | null {
  if (!entryData || typeof entryData !== "object") return null;
  const data = entryData as Partial<ScheduledReminder>;

  if (typeof data.id !== "string") return null;
  if (typeof data.message !== "string") return null;
  if (typeof data.triggerAt !== "number") return null;
  if (typeof data.createdAt !== "number") return null;
  if (typeof data.durationMs !== "number") return null;

  return {
    id: data.id,
    message: data.message,
    triggerAt: data.triggerAt,
    createdAt: data.createdAt,
    durationMs: data.durationMs,
  };
}

function fireReminder(pi: ExtensionAPI, reminder: ScheduledReminder): void {
  activeReminders.delete(reminder.id);
  pi.appendEntry(REMINDER_TRIGGERED_TYPE, {
    id: reminder.id,
    firedAt: Date.now(),
    message: reminder.message,
  });

  try {
    pi.sendUserMessage(`[sleep reminder] ${reminder.message}`, { deliverAs: "followUp" });
  } catch (error) {
    pi.appendEntry("sleep-reminder-send-error", {
      id: reminder.id,
      message: reminder.message,
      error: `${String((error as Error)?.message ?? error)}`,
    });
  }
}

function scheduleReminder(
  pi: ExtensionAPI,
  reminder: ScheduledReminder,
  ctx: ExtensionContext,
  fromRestore = false,
): void {
  const remainingMs = reminder.triggerAt - Date.now();

  const deliver = () => fireReminder(pi, reminder);
  if (remainingMs <= 0) {
    if (fromRestore) {
      setTimeout(() => deliver(), 0);
    } else {
      deliver();
    }
    return;
  }

  const timeout = setTimeout(() => {
    fireReminder(pi, reminder);
  }, remainingMs);
  (timeout as { unref?: () => void }).unref?.();

  activeReminders.set(reminder.id, { reminder, timeout });

  if (!fromRestore) {
    pi.appendEntry(REMINDER_ENTRY_TYPE, reminder);
  }

  if (ctx.hasUI) {
    const eta = formatCountdown(remainingMs);
    ctx.ui.notify(`Scheduled sleep reminder in ${eta} (${formatTriggerDate(reminder.triggerAt)})`, "info");
  }
}

function restoreFromHistory(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();

  const alreadyTriggered = new Set<string>();
  const alreadyCanceled = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== "custom") continue;

    if (entry.customType === REMINDER_TRIGGERED_TYPE && typeof entry.data === "object" && entry.data !== null) {
      const id = (entry.data as { id?: unknown }).id;
      if (typeof id === "string") alreadyTriggered.add(id);
    }

    if (entry.customType === REMINDER_CANCELED_TYPE && typeof entry.data === "object" && entry.data !== null) {
      const id = (entry.data as { id?: unknown }).id;
      if (typeof id === "string") alreadyCanceled.add(id);
    }
  }

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== REMINDER_ENTRY_TYPE) continue;

    const reminder = coerceReminderData(entry.data);
    if (!reminder) continue;
    if (alreadyTriggered.has(reminder.id) || alreadyCanceled.has(reminder.id)) continue;
    if (activeReminders.has(reminder.id)) continue;

    scheduleReminder(pi, reminder, ctx, true);
  }

  if (activeReminders.size > 0 && ctx.hasUI) {
    const count = activeReminders.size;
    ctx.ui.notify(`Restored ${count} pending sleep reminder${count === 1 ? "" : "s"}`, "info");
  }
}

function notifyStatus(ctx: ExtensionContext): void {
  const reminders = [...activeReminders.values()].sort((a, b) => a.reminder.triggerAt - b.reminder.triggerAt);

  if (reminders.length === 0) {
    ctx.ui.notify("No active sleep reminders.", "info");
    return;
  }

  const lines = reminders.map((item) => {
    const remaining = item.reminder.triggerAt - Date.now();
    return `${item.reminder.id} in ${formatCountdown(Math.max(0, remaining))} at ${formatTriggerDate(item.reminder.triggerAt)} - ${item.reminder.message}`;
  });

  ctx.ui.notify(`Active sleep reminders (${lines.length}):`, "info");
  for (const line of lines) {
    ctx.ui.notify(`  ${line}`, "info");
  }
}

function cancelReminder(pi: ExtensionAPI, ctx: ExtensionContext, id: string): boolean {
  const reminder = activeReminders.get(id);
  if (!reminder) {
    return false;
  }

  clearTimeout(reminder.timeout);
  activeReminders.delete(id);
  pi.appendEntry(REMINDER_CANCELED_TYPE, {
    id,
    canceledAt: Date.now(),
    message: reminder.reminder.message,
  });

  if (ctx.hasUI) {
    ctx.ui.notify(`Canceled sleep reminder: ${id}`, "info");
  }

  return true;
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    activeReminders.clear();
    restoreFromHistory(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    for (const { timeout } of activeReminders.values()) {
      clearTimeout(timeout);
    }
    activeReminders.clear();
  });

  pi.on("input", async (event, ctx) => {
    const trimmed = event.text.trim();
    if (event.source === "extension") return { action: "continue" };

    const match = trimmed.match(/^(?:(?:ok|okay)[,:]?\s+)?sleep\s+([\s\S]+)$/i);
    if (!match) return { action: "continue" };

    const parsed = parseSleepCommand(match[1]);
    if (!parsed) {
      ctx.ui.notify("Try: sleep <duration> then <message> (e.g. 'sleep 1 minute then talk to me again').", "warning");
      return { action: "handled" };
    }

    const reminder: ScheduledReminder = {
      id: createReminderId(),
      message: parsed.message,
      triggerAt: Date.now() + parsed.durationMs,
      createdAt: Date.now(),
      durationMs: parsed.durationMs,
    };

    scheduleReminder(pi, reminder, ctx);
    return { action: "handled" };
  });

  pi.registerTool({
    name: "sleep_resume",
    label: "Sleep and Resume",
    description:
      "Put the agent fully idle for a duration, then start a new turn with the requested task. Use this instead of bash sleep when the user asks to wait before continuing.",
    promptSnippet: "Wait without model activity, then resume with a task",
    promptGuidelines: [
      "Use sleep_resume when the user asks to wait, sleep, pause, or defer work for a duration before continuing.",
    ],
    parameters: Type.Object({
      duration: Type.String({ description: "Duration such as '30 seconds', '5 minutes', or '1 hour 30 minutes'" }),
      task: Type.String({ description: "What the agent should do when the duration expires" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const durationMs = parseDurationMs(params.duration);
      if (!durationMs) {
        throw new Error(`Invalid sleep duration: ${params.duration}`);
      }

      const reminder: ScheduledReminder = {
        id: createReminderId(),
        message: params.task.trim(),
        triggerAt: Date.now() + durationMs,
        createdAt: Date.now(),
        durationMs,
      };

      if (!reminder.message) {
        throw new Error("The wake-up task cannot be empty.");
      }

      scheduleReminder(pi, reminder, ctx);
      return {
        content: [{ type: "text", text: `Sleeping until ${formatTriggerDate(reminder.triggerAt)}. Pi is now idle.` }],
        details: reminder,
        terminate: true,
      };
    },
  });

  pi.registerCommand("sleep", {
    description:
      "Usage: /sleep <duration> [then] <message> | /sleep list | /sleep cancel <id> | /sleep cancel all",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed || /^(?:list|ls)$/i.test(trimmed)) {
        notifyStatus(ctx);
        return;
      }

      const cancelMatch = trimmed.match(/^cancel\s+([\s\S]+)$/i);
      if (cancelMatch) {
        const target = cancelMatch[1].trim();
        if (/^all$/i.test(target)) {
          let canceled = 0;
          for (const id of [...activeReminders.keys()]) {
            const canceledNow = cancelReminder(pi, ctx, id);
            if (canceledNow) canceled++;
          }
          pi.appendEntry(REMINDER_CANCELED_TYPE, {
            id: "bulk-all",
            canceledCount: canceled,
            canceledAt: Date.now(),
          });
          ctx.ui.notify(`Canceled ${canceled} pending reminder${canceled === 1 ? "" : "s"}.`, "info");
          return;
        }

        const ok = cancelReminder(pi, ctx, target);
        if (!ok) {
          ctx.ui.notify(`No active reminder with id "${target}".`, "warning");
        }
        return;
      }

      const parsed = parseSleepCommand(trimmed);
      if (!parsed) {
        ctx.ui.notify(
          "Try: /sleep <duration> then <message> (for example /sleep 1 minute then talk to me again)",
          "warning",
        );
        return;
      }

      const reminder: ScheduledReminder = {
        id: createReminderId(),
        message: parsed.message,
        triggerAt: Date.now() + parsed.durationMs,
        createdAt: Date.now(),
        durationMs: parsed.durationMs,
      };

      scheduleReminder(pi, reminder, ctx);
    },
  });
}
