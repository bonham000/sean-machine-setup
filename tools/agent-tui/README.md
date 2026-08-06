# agent-tui

`agent-tui` is the primary local session manager for Claude Code, Codex, Kimi,
and Pi. It owns each harness inside a detached pseudo-terminal (PTY), so the agent
keeps running when the visible terminal closes, the SSH connection drops, or a
client detaches. The same session can be controlled from a local terminal or a
Slack thread without teaching the harness anything about Slack.

This replaces tmux for agent TUI persistence. It is intentionally narrower
than tmux: it manages agent sessions, not general shells or multi-pane terminal
layouts. Sessions survive detach and SSH disconnects, but not a machine reboot
or an explicit stop.

## Daily workflow

The shell setup installs two aliases:

```text
a   agent-tui
an  agent-tui new
```

Run `a` to open the session manager. Sessions are grouped under `[running]`
and `[closed]` and displayed as:

```text
[core-repo] [codex] [Today 2:31 PM] • Review the session manager and...
```

The menu never uses internal IDs or raw command arguments as the visible
identifier. It records the first submitted prompt and keeps its preview to one
terminal line.

Session-manager controls:

```text
up/down or j/k  move selection
enter           attach to the selected running session
n               choose a harness and start it in the selected session's repo
x               stop the selected running session
/ or typing     fuzzy-filter sessions (use / when the query starts with n/x/q)
backspace       edit the filter
escape          clear the filter, then quit
q               quit when not filtering
```

Run `an` to skip the session list, choose Claude Code, Codex, Kimi, or Pi, and launch
it in the current Git repository. No session name is requested; an internal
random ID is generated automatically.

Inside any attached harness:

- `Cmd-L` creates or reuses its Slack thread and detaches.
- `Ctrl-\` or `Ctrl-]` detaches locally without creating Slack.
- Returning through `a` and attaching pauses Slack input and output until the
  terminal detaches again.

The managed Ghostty `Cmd-L` mapping is transmitted through SSH, so the same
shortcut works when Ghostty is connected to the Mac mini. The control-key
detach sequences are the portable fallback.

## Installation on each Mac

The normal machine setup installs dependencies and links the CLI:

```bash
cd ~/Documents/sean-machine-setup
task agent-tui:setup
task shell:setup
```

`task full-setup` and `task quick-setup` also include the agent-tui setup. The
installer creates `~/.local/bin/agent-tui` as a symlink to this tracked source
tree. Reload the shell after pulling new aliases:

```bash
reload
```

Each machine needs Bun, Node.js 22.6 or newer, the four harness CLIs and their
normal authentication, plus a `~/Documents/core-repo` checkout with access to
the Priori secrets vault. Setup refreshes the core environment from the vault
and installs the scoped Slack configuration described below. No tmux server or
Claude monitor process is involved.

Claude Code sessions are launched with `--dangerously-skip-permissions`, Codex
sessions with `--dangerously-bypass-approvals-and-sandbox`, and Kimi sessions
with `--auto`. Pi's built-in tools already run without an approval gate. This is
intentional for this trusted-machine session manager, but it also means a
detached Slack-controlled session has full access to the machine. Keep the
Slack channel private and the allowed-users list narrow.

## Slack handoff

Slack replies from allowlisted users are polled over HTTPS and injected into
the detached PTY as one sanitized bracketed paste followed by Enter. Polling
backs off from every 5 seconds for the first minute after thread activity, to
every 10 seconds through five minutes, then every 30 seconds, with jitter. A
new inbound reply or posted agent response resets the fast window. Slack 429
responses pause polling for the advertised `Retry-After` interval and post one
thread warning per rate-limit episode with the active polling phase. Completion
events are provided by launch-scoped harness adapters:

- Claude Code: a `Stop` hook passed through `--settings`.
- Codex: a `notify` command passed through `--config`.
- Pi: an extension passed through `--extension`.

The adapters write one normalized `agent-turn-complete` event. The Slack bridge
posts the final response using Slack's native Markdown block, which preserves
standard Markdown headings, emphasis, links, lists, tables, task lists and
syntax-highlighted code. Responses above Slack's 12,000-character Markdown
limit are split at paragraph boundaries.

Slack forwarding only runs while the terminal is detached. When an SSH or
local terminal attaches, the bridge leaves incoming Slack messages unread and
discards local completion events instead of duplicating them into Slack.

Each posted response ends with a mention of the notify user. Merely following a
thread earns only a conditional notification, which Slack withholds while the
client is focused on the conversation or the desktop session is active; a
mention is the only tier that is delivered unconditionally. Because forwarding
is already limited to detached sessions, a mention fires only when nobody is
watching the terminal. A multi-chunk response mentions on its final chunk, and
a backlog that flushes after a detach mentions once rather than once per queued
turn.

`task agent-tui:setup` runs `task secrets:load` in `core-repo`, selects only the
variables below, and atomically writes them to the private mode-`0600` file
`~/.config/agent-tui/.env`:

```text
SLACK_BOT_TOKEN_AGENT_COMMS
SLACK_AGENT_COMMS_CHANNEL
SLACK_AGENT_COMMS_ALLOWED_USERS
```

At runtime, configuration is read from the current environment, an explicit
`AGENT_TUI_ENV_FILE`, or `~/.config/agent-tui/.env`, in that order. Active
project `.env` files are never consulted. Set `AGENT_TUI_CORE_REPO` only when
the provisioning checkout is somewhere other than `~/Documents/core-repo`.

The mention target defaults to the sole allowed user, so single-operator
machines need no extra configuration. When the allowlist names more than one
person the target is ambiguous and no mention is sent; set the optional
`SLACK_AGENT_COMMS_NOTIFY_USER` to a Slack user ID to state it explicitly. That
variable is read from the same sources but is deliberately not provisioned by
`agent-tui:setup`, which treats every variable it writes as mandatory.

The allowed-users variable is mandatory and comma-separated. The poller does
not use Socket Mode, so the same Slack app can safely serve the laptop and Mac
mini simultaneously. The root message includes the machine identity to keep
threads distinguishable.

Each new control thread starts with a compact, path-free summary and a
20-word preview of the first submitted prompt:

```text
`agent-tui` `mbp` `core-repo` • `codex`
Review the current implementation and identify any lifecycle risks...
```

## SSH and persistence model

The user-facing CLI starts a detached Node process with its standard streams
redirected to private log files. That process owns both the PTY child and a
Unix socket under `~/.local/state/agent-tui/runtime/`. It is in a separate
process group and explicitly ignores `SIGHUP`, so an SSH client disappearing
does not terminate the agent. Reattaching from a later SSH login connects to
the same socket and replays up to the last 2 MiB of terminal output.

State, logs, completion events and Slack bindings are stored under:

```text
~/.local/state/agent-tui/
```

Directories and files are created with user-only permissions. On the next menu
load, records that claim to be running but no longer answer their socket are
reconciled into the `[closed]` group. Override `AGENT_TUI_HOME` and
`AGENT_TUI_RUNTIME` only for isolated tests.

## Advanced commands

The interactive manager is the normal interface. Scriptable primitives remain
available for diagnostics and automation:

```bash
agent-tui new --harness codex --detached
agent-tui new --harness kimi --detached
agent-tui run --cwd DIR --detached -- COMMAND [ARGS...]
agent-tui attach SESSION
agent-tui send SESSION "Explain the current implementation"
printf 'Review these files:\n- src/a.ts\n- src/b.ts\n' | agent-tui send SESSION --stdin
agent-tui slack SESSION
agent-tui capture SESSION
agent-tui list
agent-tui list --json
agent-tui stop SESSION
```

`capture` exposes raw ANSI terminal traffic for diagnostics; it is not a
structured transcript. Internal session IDs are available through
`list --json` when one of the advanced commands needs an unambiguous target.

## Extending to another harness

Harness registration is centralized in `src/adapters.ts`:

1. Add a `HarnessDefinition` to `HARNESSES` with its stable ID, menu label and
   executable.
2. Add the smallest launch-scoped adapter in `commandArgsWithAdapters`.
3. Have that adapter append a JSON line containing `type:
   "agent-turn-complete"` and `last-assistant-message` to the path returned by
   `sessionEventsPath(AGENT_TUI_SESSION_ID)`.
4. Add adapter and real-payload tests. The PTY, menu, Slack input, persistence
   and Markdown output layers require no harness-specific changes.

Prefer a native completion callback, hook, or extension. Terminal-screen
scraping is deliberately not used because full-screen output is presentation
traffic rather than a stable transcript API.

## Maintenance

Run the focused tool checks while developing:

```bash
cd tools/agent-tui
bun run check
```

Changes to aliases, setup tasks or other shell configuration also require the
repo-level gate:

```bash
cd ~/Documents/sean-machine-setup
task check
```

The main implementation boundaries are:

- `cli.ts`: commands, launch lifecycle, attach/detach and orchestration.
- `session-menu.ts`, `picker.ts`, `terminal-ui.ts`: interactive UX.
- `daemon.ts`, `client.ts`, `protocol.ts`: PTY ownership and local IPC.
- `session-metadata.ts`, `store.ts`, `paths.ts`: labels and persistence.
- `adapters.ts` plus harness hook files: completion normalization.
- `slack-*.ts`: Slack binding, API and detached relay.

The relay cannot determine whether a harness is showing its editor or a
permission dialog. Slack injection should therefore be used when the harness
is ready for normal prompt input; harness-native remote-control protocols can
be added later if they expose a safer state signal.
