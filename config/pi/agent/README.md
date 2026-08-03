# Shared Pi config (portable)

This folder stores only non-secret, machine-agnostic Pi configuration:

- `settings.defaults.json` — stable settings merged into each machine's local
  `settings.json`
- `settings.seed.json` — initial values used only when a local settings file is
  missing or an old tracked symlink is already dangling
- `keybindings.json` — portable key remappings, linked directly
- `extensions/` — portable Pi TUI extensions, linked individually into the
  machine-local extension directory

Only settings that should stay identical across machines belong in
`settings.defaults.json`. Provider, model, thinking level, and
`lastChangelogVersion` are Pi runtime choices and must remain in the untracked
`~/.pi/agent/settings.json`. Their seed values establish a usable first run but
are never reapplied over an existing local file.

Do **not** place any secrets here.

## Machine-local files (kept on each host)

`pi` should keep these outside git sync:

- `~/.pi/agent/auth.json` – API keys / OAuth tokens
- `~/.pi/agent/settings.json` – provider, model, thinking, and runtime state
- `~/.pi/agent/models.json` – provider catalog with API key values
- `~/.pi/agent/models-store.json` – cached provider metadata
- `~/.pi/agent/sessions/*` – local session history
- `~/.pi/agent/trust.json` – local trust decisions

## Setup

Run `task pi:setup` from this repo. It links the tracked keybindings and
extensions, then merges
the stable defaults into a normal machine-local `~/.pi/agent/settings.json`.
It never replaces the model, provider, thinking level, or changelog version.

The setup also migrates the old tracked `settings.json` symlink. If that link is
already dangling after an update, the seed restores a normal local file.
