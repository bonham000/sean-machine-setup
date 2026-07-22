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
