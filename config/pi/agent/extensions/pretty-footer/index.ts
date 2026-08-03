import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Usage = AssistantMessage["usage"];

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

type Rgb = readonly [red: number, green: number, blue: number];

const PASTEL = {
  sky: [137, 180, 250],
  mint: [166, 227, 161],
  lavender: [203, 166, 247],
  peach: [250, 179, 135],
  butter: [249, 226, 175],
  rose: [243, 139, 168],
  periwinkle: [180, 190, 254],
} satisfies Record<string, Rgb>;

function paint(text: string, [red, green, blue]: Rgb): string {
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function addUsage(totals: Totals, usage: Usage | undefined): void {
  if (!usage) return;
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function formatCwd(cwd: string): string {
  const home = resolve(homedir());
  const absolute = resolve(cwd);
  const fromHome = relative(home, absolute);
  const insideHome =
    fromHome === "" ||
    (fromHome !== ".." && !fromHome.startsWith(`..${sep}`));
  if (!insideHome) return cwd;
  return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function installFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const totals: Totals = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        };
        let latestCacheHitRate: number | undefined;

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            const usage = entry.message.usage;
            addUsage(totals, usage);
            const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
            latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
          } else if (entry.type === "message" && entry.message.role === "toolResult") {
            addUsage(totals, entry.message.usage);
          } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
            addUsage(totals, entry.usage);
          }
        }

        let location = formatCwd(ctx.cwd);
        const branch = footerData.getGitBranch();
        if (branch) location += ` (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) location += ` • ${sessionName}`;

        const pieces: string[] = [];
        if (totals.input) pieces.push(paint(`↑ ${formatTokens(totals.input)}`, PASTEL.sky));
        if (totals.output) pieces.push(paint(`↓ ${formatTokens(totals.output)}`, PASTEL.mint));
        if (totals.cacheRead || totals.cacheWrite) {
          let cache = theme.fg("dim", "cache ") + paint(formatTokens(totals.cacheRead), PASTEL.lavender);
          if (totals.cacheWrite) cache += theme.fg("dim", " / W") + paint(formatTokens(totals.cacheWrite), PASTEL.lavender);
          if (latestCacheHitRate !== undefined) {
            cache += theme.fg("dim", " · ") + paint(`${latestCacheHitRate.toFixed(1)}%`, PASTEL.peach);
          }
          pieces.push(cache);
        }

        const provider = ctx.model?.provider;
        const subscription = provider === "openai-codex" || provider === "kimi-coding";
        if (totals.cost || subscription) {
          pieces.push(
            theme.fg("dim", "cost ") +
              paint(`$${totals.cost.toFixed(3)}`, PASTEL.rose) +
              (subscription ? theme.fg("dim", " sub") : ""),
          );
        }

        const context = ctx.getContextUsage();
        const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = context?.percent;
        const percentText = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
        pieces.push(
          theme.fg("dim", "ctx ") +
            paint(percentText, PASTEL.periwinkle) +
            theme.fg("dim", ` / ${formatTokens(contextWindow)} auto`),
        );

        let leftText = pieces.join(theme.fg("dim", "  "));
        const modelName = ctx.model?.id ?? "no-model";
        let rightText = modelName;
        if (ctx.model?.reasoning) {
          const thinkingText = ctx.thinkingLevel === "off" ? "thinking off" : ctx.thinkingLevel;
          rightText += ` • ${thinkingText}`;
        }
        if (ctx.model && footerData.getAvailableProviderCount() > 1) {
          rightText = `(${ctx.model.provider}) ${rightText}`;
        }
        const right = paint(rightText, PASTEL.butter);

        const rightWidth = visibleWidth(right);
        const maxLeftWidth = Math.max(0, width - rightWidth - 2);
        leftText = truncateToWidth(leftText, maxLeftWidth, theme.fg("dim", "…"));
        const left = leftText;
        const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - rightWidth));
        const statsLine = truncateToWidth(left + padding + right, width, "");

        const lines = [
          truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "…")),
          statsLine,
        ];

        const statuses = [...footerData.getExtensionStatuses().entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitize(text));
        if (statuses.length > 0) {
          lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "…")));
        }
        return lines;
      },
    };
  });
}

export default function prettyFooter(pi: ExtensionAPI): void {
  let enabled = true;

  pi.on("session_start", (_event, ctx) => {
    if (enabled) installFooter(ctx);
  });

  pi.registerCommand("pretty-footer", {
    description: "Use /pretty-footer on or /pretty-footer off to switch between the styled and stock footer",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") {
        enabled = true;
        installFooter(ctx);
        ctx.ui.notify("Styled footer enabled", "info");
      } else if (action === "off" || action === "stock") {
        enabled = false;
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("Stock Pi footer restored", "info");
      } else if (action === "status") {
        ctx.ui.notify(`Styled footer is ${enabled ? "enabled" : "disabled"}`, "info");
      } else {
        ctx.ui.notify("Usage: /pretty-footer on | off", "warning");
      }
    },
  });
}
