/**
 * Environment construction for spawned processes.
 *
 * Every process this tool starts — the session daemon, the agent harness inside
 * the pty, the Slack bridge — used to receive `{ ...process.env }`. That is a
 * leak with a long fuse: the daemon inherits whatever shell started it, and if
 * that shell had a repo's `.env` loaded, the daemon carries those secrets for
 * its entire lifetime and hands them to *every* session it later spawns, in
 * every repo. One observed instance had a client repo's full `.env` — database
 * URL, auth secret, OAuth client secrets, provider API tokens, ~40 values —
 * present in sessions opened against unrelated internal repos.
 *
 * It also silently defeats per-repo `.env` files. Bun and dotenv only fill in
 * variables that are *unset*, so an inherited `DATABASE_URL` wins over the one
 * the repo declares. The repo's own config is read and then discarded, with no
 * warning, and commands run against the wrong account.
 *
 * So the base environment is an allowlist: names a spawned process needs to
 * function (toolchain discovery, terminal behaviour, SSH agent for git), and
 * nothing that looks like application configuration. Anything a session needs
 * beyond this should come from the repo's own `.env`, which is the mechanism
 * that was being bypassed.
 *
 * Adding a name here is a deliberate act. If a harness turns out to need one,
 * add it with a reason — or use AGENT_TUI_ENV_PASSTHROUGH for a machine-local
 * exception that should not be baked into the tool.
 */

/**
 * Exact names forwarded to spawned processes.
 *
 * Deliberately absent: anything scoped to an application or an account —
 * `DATABASE_URL`, `*_API_TOKEN`, `*_SECRET`, `*_WEBHOOK_*`, and friends. Those
 * belong to a repo, and the repo's `.env` supplies them.
 */
const ALLOWED_EXACT: ReadonlySet<string> = new Set([
  // Process + shell basics. Without PATH and HOME nothing resolves at all;
  // HOME also carries each harness's own credential store (~/.claude, ~/.codex).
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "TZ",
  "ZDOTDIR",
  "SHLVL",
  // Terminal identity and colour. The pty is interactive; getting these wrong
  // produces mangled output rather than an obvious failure.
  "TERM",
  "TERMINFO",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  // Git over SSH and commit signing. Dropping the agent socket turns every
  // push into an auth prompt inside a detached session.
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  // Editor/pager, for tools that shell out to one.
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPATH",
  // Toolchain roots. Not secrets, and their absence breaks builds in ways that
  // look like unrelated tooling faults.
  "BUN_INSTALL",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  // Machine identity, read by this tool and by repo agent instructions.
  "MACHINE_ID",
  // macOS process plumbing.
  "COMMAND_MODE",
  "__CF_USER_TEXT_ENCODING",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
]);

/**
 * Prefixes forwarded wholesale.
 *
 * Each is a namespace owned by a tool rather than by an application:
 * `AGENT_TUI_` is this tool's own configuration, `FNM_` is the Node version
 * manager whose shims are already on PATH, `GHOSTTY_` is terminal integration,
 * `LC_` is locale, `XDG_`/`HOMEBREW_` are standard install-location hints.
 */
const ALLOWED_PREFIXES: readonly string[] = [
  "AGENT_TUI_",
  "FNM_",
  "GHOSTTY_",
  "LC_",
  "XDG_",
  "HOMEBREW_",
];

/**
 * Machine-local escape hatch: a comma-separated list of additional names to
 * forward. Exists so a missing variable can be fixed on the spot without
 * editing and redeploying the tool — but it is opt-in and visible, unlike
 * inheriting everything by default.
 */
function passthroughNames(source: NodeJS.ProcessEnv): string[] {
  return (source.AGENT_TUI_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function isAllowed(name: string, extraNames: readonly string[]): boolean {
  if (ALLOWED_EXACT.has(name)) return true;
  if (extraNames.includes(name)) return true;
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Build the environment for a spawned process: the allowlisted subset of
 * `source`, plus `overrides`.
 *
 * `overrides` are applied last and unconditionally — they are values this tool
 * is deliberately setting (session identity), not inherited state.
 */
export function buildSpawnEnv(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const extraNames = passthroughNames(source);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!isAllowed(name, extraNames)) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

/** Names in `source` that `buildSpawnEnv` drops. Used for reporting. */
export function droppedEnvNames(source: NodeJS.ProcessEnv): string[] {
  const extraNames = passthroughNames(source);
  return Object.keys(source)
    .filter((name) => !isAllowed(name, extraNames))
    .sort();
}
