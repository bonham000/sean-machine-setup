# Shared Pi config (portable)

This folder stores only non-secret Pi files:

- `settings.json` (global Pi settings)
- `keybindings.json` (optional key remappings)

Do **not** place any secrets here.

## Machine-local files (kept on each host)

`pi` should keep these outside git sync:

- `~/.pi/agent/auth.json` – API keys / OAuth tokens
- `~/.pi/agent/models.json` – provider catalog with API key values
- `~/.pi/agent/models-store.json` – cached provider metadata
- `~/.pi/agent/sessions/*` – local session history
- `~/.pi/agent/trust.json` – local trust decisions

## Setup

Run `task pi:setup` (from this repo) to sync the tracked Pi config into
`~/.pi/agent/`. Existing local files are backed up before replacement
except the machine-local files above, which are skipped.

If you want to migrate another tracked file, add it under
`config/pi/agent/` and rerun `task pi:setup`.
