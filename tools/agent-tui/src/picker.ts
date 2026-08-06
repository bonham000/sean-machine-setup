import { fuzzyScore, readTerminalInput, splitInputKeys, terminal } from "./terminal-ui";

export interface PickerOptions<T> {
  title: string;
  detail?: string;
  items: readonly T[];
  renderItem: (item: T) => string;
}

export function filterPickerItems<T>(
  items: readonly T[],
  renderItem: (item: T) => string,
  query: string,
): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(renderItem(item), query) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}

export async function singleSelect<T>(options: PickerOptions<T>): Promise<T | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive selection requires a terminal");
  if (options.items.length === 0) return null;
  const originalRaw = process.stdin.isRaw;
  let query = "";
  let visible = options.items.slice();
  let selected = 0;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(terminal.hideCursor);

  const updateVisible = (): void => {
    const selectedItem = visible[selected];
    visible = filterPickerItems(options.items, options.renderItem, query);
    const preserved = visible.indexOf(selectedItem as T);
    selected = preserved >= 0 ? preserved : 0;
  };

  const render = (): void => {
    process.stdout.write(terminal.clearScreen);
    process.stdout.write(`${terminal.title(options.title)}\n`);
    if (options.detail) process.stdout.write(`${terminal.muted(options.detail)}\n`);
    process.stdout.write(`${terminal.muted("Filter:")} ${query || terminal.muted("type to filter")}\n\n`);

    if (visible.length === 0) {
      process.stdout.write(`  ${terminal.muted(`No matches for "${query}".`)}\n`);
    } else {
      for (let index = 0; index < visible.length; index += 1) {
        const label = options.renderItem(visible[index]!);
        process.stdout.write(`${terminal.cursor(index === selected)} ${index === selected ? terminal.strong(label) : label}\n`);
      }
    }
    process.stdout.write(`\n${terminal.muted("up/down: navigate   enter: select   esc: clear or cancel")}\n`);
  };

  try {
    render();
    while (true) {
      for (const key of splitInputKeys(await readTerminalInput())) {
        if (key === "\u0003") return null;
        if (key === "\u001b") {
          // Escape clears a query first so a mistyped filter does not discard
          // the whole selection.
          if (!query) return null;
          query = "";
          updateVisible();
        } else if (key === "\u001b[A") {
          if (visible.length > 0) selected = (selected - 1 + visible.length) % visible.length;
        } else if (key === "\u001b[B") {
          if (visible.length > 0) selected = (selected + 1) % visible.length;
        } else if (key === "\r" || key === "\n") {
          const item = visible[selected];
          if (item !== undefined) return item;
        } else if (key === "\u007f" || key === "\b") {
          query = Array.from(query).slice(0, -1).join("");
          updateVisible();
        } else if (key >= " ") {
          // The list is short enough that type-to-select beats reserving
          // letters for navigation, so every printable key filters.
          query += key;
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
