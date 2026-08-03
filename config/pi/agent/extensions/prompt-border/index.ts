import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const BLUE = "\x1b[38;2;137;180;250m";
const RESET_FOREGROUND = "\x1b[39m";

class BluePromptEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
  }

  render(width: number): string[] {
    // Pi normally changes this with the thinking level. Reassert the chosen
    // color at render time so both prompt borders remain consistently blue.
    this.borderColor = (text: string) => `${BLUE}${text}${RESET_FOREGROUND}`;
    return super.render(width);
  }
}

export default function promptBorder(pi: ExtensionAPI): void {
  let enabled = true;

  const install = (ctx: ExtensionContext): void => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new BluePromptEditor(tui, theme, keybindings),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    if (enabled) install(ctx);
  });

  pi.registerCommand("prompt-border", {
    description: "Use /prompt-border on or /prompt-border off to toggle the blue prompt border",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") {
        enabled = true;
        install(ctx);
        ctx.ui.notify("Blue prompt border enabled", "info");
      } else if (action === "off" || action === "stock") {
        enabled = false;
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.notify("Stock Pi prompt border restored", "info");
      } else if (action === "status") {
        ctx.ui.notify(`Blue prompt border is ${enabled ? "enabled" : "disabled"}`, "info");
      } else {
        ctx.ui.notify("Usage: /prompt-border on | off", "warning");
      }
    },
  });
}
