import { sessionLabel } from "./session-metadata";
import { fuzzyScore, readTerminalInput, splitInputKeys, terminal } from "./terminal-ui";
import type { SessionRecord } from "./types";

export type SessionMenuActions = {
  load: () => Promise<SessionRecord[]>;
  attach: (session: SessionRecord) => Promise<void>;
  stop: (session: SessionRecord) => Promise<void>;
  create: (cwd: string) => Promise<void>;
};

export function sessionSection(session: SessionRecord): "running" | "closed" {
  return session.status === "running" || session.status === "starting" ? "running" : "closed";
}

export function filterSessions(sessions: readonly SessionRecord[], query: string): SessionRecord[] {
  const ranked = sessions
    .map((session, index) => ({ session, index, score: fuzzyScore(sessionLabel(session), query) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null);
  return (["running", "closed"] as const).flatMap((section) =>
    ranked
      .filter((entry) => sessionSection(entry.session) === section)
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((entry) => entry.session),
  );
}

function visibleItemCount(): number {
  return Math.max(3, Math.min(30, (process.stdout.rows || 24) - 11));
}

export async function sessionMenu(actions: SessionMenuActions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("agent-tui requires an interactive terminal");
  const originalRaw = process.stdin.isRaw;
  let sessions = await actions.load();
  let visible = filterSessions(sessions, "");
  let selected = 0;
  let scroll = 0;
  let query = "";
  let filtering = false;
  let status = "";

  const updateVisible = (): void => {
    const selectedId = visible[selected]?.id;
    visible = filterSessions(sessions, query);
    const preserved = visible.findIndex((session) => session.id === selectedId);
    selected = preserved >= 0 ? preserved : Math.min(selected, Math.max(visible.length - 1, 0));
    const count = visibleItemCount();
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + count) scroll = selected - count + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, visible.length - count)));
  };

  const reload = async (): Promise<void> => {
    sessions = await actions.load();
    updateVisible();
  };

  const render = (): void => {
    process.stdout.write(terminal.clearScreen);
    process.stdout.write(`${terminal.title("Agent sessions")}\n`);
    const filterValue = query || (filtering ? terminal.muted("type to filter") : terminal.muted("press / to filter"));
    process.stdout.write(`${terminal.muted("Filter:")} ${filterValue}  ${terminal.muted(`${visible.length}/${sessions.length}`)}\n\n`);

    if (visible.length === 0) {
      const empty = sessions.length === 0 ? "No sessions yet. Press n to start one." : `No matches for "${query}".`;
      process.stdout.write(`  ${terminal.muted(empty)}\n`);
    } else {
      const end = Math.min(visible.length, scroll + visibleItemCount());
      let priorSection: string | null = null;
      const lineWidth = Math.max(20, (process.stdout.columns || 100) - 4);
      for (let index = scroll; index < end; index += 1) {
        const session = visible[index]!;
        const section = sessionSection(session);
        if (section !== priorSection) {
          if (priorSection !== null) process.stdout.write("\n");
          process.stdout.write(`  ${terminal.section(`[${section}]`)}\n`);
          priorSection = section;
        }
        const label = terminal.truncate(sessionLabel(session), lineWidth);
        const rendered = index === selected ? terminal.strong(label) : section === "closed" ? terminal.muted(label) : label;
        process.stdout.write(`${terminal.cursor(index === selected)} ${rendered}\n`);
      }
      if (visible.length > visibleItemCount()) {
        process.stdout.write(`\n  ${terminal.muted(`Showing ${scroll + 1}-${end} of ${visible.length}`)}\n`);
      }
    }
    if (status) process.stdout.write(`\n${terminal.warning(status)}\n`);
    process.stdout.write(`\n${terminal.muted("up/down or j/k: navigate   enter: attach   n: new   x: stop   /: filter   q: quit")}\n`);
  };

  const suspend = async (operation: () => Promise<void>): Promise<void> => {
    process.stdin.setRawMode(originalRaw ?? false);
    process.stdin.pause();
    process.stdout.write(`${terminal.clearScreen}${terminal.showCursor}`);
    try {
      await operation();
      status = "";
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(terminal.hideCursor);
    await reload();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(terminal.hideCursor);
  try {
    render();
    while (true) {
      for (const key of splitInputKeys(await readTerminalInput())) {
        if (key === "\u0003") return;
        if (key === "\u001b") {
          if (query || filtering) {
            query = "";
            filtering = false;
            updateVisible();
          } else return;
        } else if (!filtering && (key === "q" || key === "Q")) {
          return;
        } else if (key === "\u001b[A" || (!filtering && key === "k")) {
          if (visible.length > 0) selected = (selected - 1 + visible.length) % visible.length;
          updateVisible();
        } else if (key === "\u001b[B" || (!filtering && key === "j")) {
          if (visible.length > 0) selected = (selected + 1) % visible.length;
          updateVisible();
        } else if (key === "\r" || key === "\n") {
          const session = visible[selected];
          if (!session) status = "Press n to start a session.";
          else if (sessionSection(session) === "closed") status = "That session is closed; press n to start another in the same repo.";
          else await suspend(async () => await actions.attach(session));
        } else if (!filtering && (key === "n" || key === "N")) {
          const cwd = visible[selected]?.repoRoot || visible[selected]?.cwd || process.cwd();
          await suspend(async () => await actions.create(cwd));
        } else if (!filtering && (key === "x" || key === "X")) {
          const session = visible[selected];
          if (!session) status = "No session selected.";
          else if (sessionSection(session) === "closed") status = "That session is already closed.";
          else {
            await actions.stop(session).catch((error) => {
              status = error instanceof Error ? error.message : String(error);
            });
            await reload();
          }
        } else if (!filtering && key === "/") {
          filtering = true;
        } else if (filtering && (key === "\u007f" || key === "\b")) {
          query = Array.from(query).slice(0, -1).join("");
          updateVisible();
        } else if (filtering && key >= " ") {
          query += key;
          updateVisible();
        } else if (!filtering && key >= " " && !["n", "N", "x", "X", "q", "Q"].includes(key)) {
          filtering = true;
          query = key;
          updateVisible();
        }
      }
      render();
    }
  } finally {
    process.stdin.setRawMode(originalRaw ?? false);
    process.stdin.pause();
    process.stdout.write(`${terminal.clearScreen}${terminal.showCursor}`);
  }
}
