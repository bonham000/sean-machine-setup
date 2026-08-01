import { readTerminalInput, splitInputKeys, terminal } from "./terminal-ui";

export interface PickerOptions<T> {
  title: string;
  detail?: string;
  items: readonly T[];
  renderItem: (item: T) => string;
}

export async function singleSelect<T>(options: PickerOptions<T>): Promise<T | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive selection requires a terminal");
  if (options.items.length === 0) return null;
  const originalRaw = process.stdin.isRaw;
  let selected = 0;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(terminal.hideCursor);

  const render = (): void => {
    process.stdout.write(terminal.clearScreen);
    process.stdout.write(`${terminal.title(options.title)}\n`);
    if (options.detail) process.stdout.write(`${terminal.muted(options.detail)}\n`);
    process.stdout.write("\n");
    for (let index = 0; index < options.items.length; index += 1) {
      const label = options.renderItem(options.items[index]!);
      process.stdout.write(`${terminal.cursor(index === selected)} ${index === selected ? terminal.strong(label) : label}\n`);
    }
    process.stdout.write(`\n${terminal.muted("up/down or j/k: navigate   enter: select   q or esc: cancel")}\n`);
  };

  try {
    render();
    while (true) {
      for (const key of splitInputKeys(await readTerminalInput())) {
        if (key === "\u0003" || key === "q" || key === "Q" || key === "\u001b") return null;
        if (key === "\u001b[A" || key === "k") selected = (selected - 1 + options.items.length) % options.items.length;
        else if (key === "\u001b[B" || key === "j") selected = (selected + 1) % options.items.length;
        else if (key === "\r" || key === "\n") return options.items[selected] ?? null;
      }
      render();
    }
  } finally {
    process.stdin.setRawMode(originalRaw ?? false);
    process.stdin.pause();
    process.stdout.write(`${terminal.clearScreen}${terminal.showCursor}`);
  }
}
