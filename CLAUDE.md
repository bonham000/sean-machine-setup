# Agent Instructions

## Shell shortcuts

- `shell/init.sh` is the single shell entry point.
- Add or edit aliases only in `shell/aliases.sh`.
- Add or edit small sourced functions only in `shell/functions.sh`.
- Keep interactive picker implementations in the executable root `*.zsh`
  scripts and expose them from `shell/aliases.sh` or `shell/functions.sh`.
- Do not write shortcut definitions directly into `.zshrc`, `.bashrc`, setup
  scripts, or generated home-directory files.
- `bash/aliases.sh` and `scripts/task-aliases.sh` are compatibility shims; do
  not add shortcuts to them.
- Run `task check` after changing shell configuration or a picker.

## Setup behavior

- `scripts/shell-config.sh` owns shell installation and links
  `~/.bash_aliases` to `shell/init.sh`.
- `scripts/git-config.sh` separately owns Git-native aliases.
- Preserve existing shortcut behavior unless the requested change explicitly
  renames or removes a command.

## Agent infrastructure

- `tools/agent-tui` owns persistent interactive Claude Code, Codex, Kimi, and Pi
  terminal sessions and detached-session Slack relay behavior.
- `tools/agent-comms` owns the Mac Mini Socket Mode daemon for Slack-originated
  headless harness sessions. Preserve its launchd label
  `com.priori.agent-comms` and state directory `~/.claude/agent-comms` across
  upgrades.
- `tools/agent-relay` owns installation of the singleton Mac Mini agent relay.
  Preserve its launchd label `com.priori.agent-relay`; runtime bundles, target
  registry, tokens, and listener lifecycle remain owned by `core-repo`.
  Remote fleet restarts must connect to the Mini without inspecting the
  invoking machine's repositories; the Mini owns checkout validation, pulls,
  staging, and restart safety gates.
- Slack credentials remain canonical in `~/Documents/core-repo/.env` and the
  Priori secrets vault; do not commit or duplicate them here.
- Run `task check` after changing either agent tool.
