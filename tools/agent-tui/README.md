# agent-tui prototype

`agent-tui` keeps a native terminal application alive behind a small PTY
supervisor. A terminal can detach and reattach while another local process can
inject a pasted prompt. The child application does not need to know where the
input came from.

`Cmd-L` hands the live session to a Slack thread. A daemonless HTTPS poller
receives allowlisted replies and injects them into the PTY, so the same Slack
app can be used safely from more than one machine. Wrapped Codex sessions
receive a launch-scoped notifier, wrapped Pi sessions receive a launch-scoped
extension, and wrapped Claude Code sessions receive a launch-scoped `Stop`
hook. All three post the final assistant message back to the thread without
changing the harness's global configuration. Common Markdown in agent replies
is sent through Slack's native Markdown block, including emphasis, headings,
links, lists, syntax-highlighted code fences, tables, and task lists.

The prototype currently requires Bun and Node.js 22.6 or newer. The detached
PTY owner runs under Node because `node-pty` event delivery is not reliable
under Bun on macOS; the user-facing CLI still runs under Bun.

## Install

```bash
cd ~/Documents/sean-machine-setup/tools/agent-tui
bun install --frozen-lockfile
bun run install:cli
```

The installer links `agent-tui` into `~/.local/bin/`.

## Try it

Start and attach to an ordinary agent TUI:

```bash
agent-tui run --name codex -- codex
```

With the managed Ghostty profile, press `Cmd-L` to create or reuse a Slack
control thread and detach without stopping Codex. The command prints the Slack
thread URL after the bridge is live. Use `Ctrl-\` (or `Ctrl-]`) when you only
want to detach locally without attaching Slack. Reattach later:

```bash
agent-tui list
agent-tui attach <session-id>
```

Reattaching pauses both directions of the Slack relay. Local Codex completions
are not copied to Slack, and new Slack replies remain unread until the terminal
detaches again. Any detach resumes the existing thread automatically.

You can also create the Slack attachment explicitly:

```bash
agent-tui slack <session-id>
```

On detach, the wrapper restores keyboard, mouse, bracketed-paste, cursor, and
alternate-screen modes that the child TUI enabled on the physical terminal.

From another terminal, inject one prompt as bracketed paste followed by Enter:

```bash
agent-tui send <session-id> "Explain the current implementation"
printf 'Review these files:\n- src/a.ts\n- src/b.ts\n' |
  agent-tui send <session-id> --stdin
```

Other commands:

```bash
agent-tui capture <session-id>
agent-tui stop <session-id>
```

`capture` is intended for diagnostics. Full-screen TUI output is ANSI terminal
traffic and should not be treated as a structured agent transcript.

## State and security

Session metadata and output logs live under
`~/.local/state/agent-tui/sessions/`. Per-session Unix sockets live in a
mode-0700 runtime directory under the system temporary directory. Override
these locations with `AGENT_TUI_HOME` and `AGENT_TUI_RUNTIME` for tests.

Slack configuration comes from the current environment, `AGENT_TUI_ENV_FILE`,
the nearest repo `.env`, or `~/Documents/core-repo/.env`. Required variables
are `SLACK_BOT_TOKEN_AGENT_COMMS`, `SLACK_AGENT_COMMS_CHANNEL`, and
`SLACK_AGENT_COMMS_ALLOWED_USERS`. The bridge uses `chat.postMessage` and
`conversations.replies`; it does not use Socket Mode and therefore does not
compete with a daemon running on another machine.

Injected text has NUL, escape, and other terminal control characters removed.
The supervisor writes it as one bracketed paste. The prototype does not yet
know whether a harness is showing its normal editor or a permission dialog, so
only inject when the TUI is visibly ready for prompt input.
