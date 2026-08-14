# Sean Machine Setup Scripts

Bootstrap scripts for setting up development environments with all necessary tools and configurations.

## 🚀 Quick Start

```bash
# Clone this repository
git clone https://github.com/bonham000/sean-machine-setup.git
cd sean-machine-setup

# Install gh and login
bash scripts/install-gh.sh
gh auth login

# Install Task
sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin

# Run setup
task full-setup
```

### Required Tools

1. **Git** - For cloning repositories (if not already installed)
   ```bash
   sudo apt install git
   ```

2. **GitHub CLI** - For managing repositories

   ```bash
   bash scripts/install-gh.sh

   gh auth login
   ```

3. **Task** - Task runner (required to run the setup)

   ```bash
   sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin
   ```

## 📝 Available Tasks

### Main Tasks

| Task                     | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `task` or `task default` | Complete machine setup - installs all tools and configurations |
| `task check`             | Validate shell shortcuts and interactive tools                    |
| `task quick-setup`       | Quick setup without heavy installations                        |
| `task pi:setup`          | Install portable Pi configuration from this repo                |
| `task ghostty:setup`     | Install and configure the Ghostty profile on macOS              |
| `task theme-switcher:setup` | Install the macOS Appearance, CPU, and RAM menu-bar controls   |
| `task agent-tui:setup`   | Install the persistent multi-harness terminal session manager    |
| `task machine:setup -- --machine <id>` | Install this machine's agent identity               |
| `task agent-docs:setup`  | Install global agent instruction links from `core-repo`           |
| `task help`              | Show all available tasks                                       |
| `task clean`             | Clean up temporary files and caches                            |

### Git Configuration

| Task               | Description                         |
| ------------------ | ----------------------------------- |
| `task git:setup`   | Setup git configuration and aliases |
| `task git:aliases` | Setup git aliases only              |
| `task git:config`  | Setup git configuration only        |

### System Dependencies

| Task                         | Description                 |
| ---------------------------- | --------------------------- |
| `task system:install-deps`   | Install system dependencies |

### Development Tools

| Task                     | Description                         |
| ------------------------ | ----------------------------------- |
| `task tools:install-all` | Install all development tools       |
| `task tools:bun`         | Install Bun JavaScript runtime      |
| `task tools:fnm-node`    | Install fnm and Node.js LTS         |
| `task tools:rust`        | Install Rust and Cargo              |
| `task tools:loc`         | Install loc (lines of code counter) |
| `task tools:ai-cli`      | Install AI CLI tools                |

### Coding Agents

| Task                       | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `task coding-agents:update` | Update Claude, Codex, and Gemini CLIs to their latest versions |

### Agent Infrastructure

This repository is the canonical home for machine-level agent tooling:

- `tools/agent-tui` keeps Claude Code, Codex, Kimi, and Pi terminal sessions alive,
  allows local detach/reattach, and relays detached sessions through Slack.
- `tools/agent-comms` runs the Mac Mini Socket Mode daemon that starts headless
  harness threads from Slack mentions.
- `tools/agent-relay` installs the singleton loopback relay LaunchAgent while
  delegating staged builds and fleet lifecycle to `core-repo`'s `agents:*`
  commands.
- `config/machine-identities` and `task machine:setup` identify the current
  workstation to agent sessions.

The daemon intentionally preserves the launchd label
`com.priori.agent-comms` and state directory `~/.claude/agent-comms`, so moving
its source here does not replace its registry or thread state. Slack
credentials remain owned by the Priori vault and the `core-repo` root `.env`.
`task agent-tui:setup` refreshes that environment through the vault tooling and
writes only the agent-tui Slack variables to the private runtime file
`~/.config/agent-tui/.env`; active project environments are not used.
Install or upgrade the daemon on the Mac Mini with:

```bash
cd ~/Documents/core-repo
task secrets:load
cd ~/Documents/sean-machine-setup
task agent-comms:install
```

Use `task agent-comms:status`, `task agent-comms:logs`,
`task agent-comms:start`, and `task agent-comms:stop` for normal operation.
The daemon is not part of `full-setup` because only one Socket Mode instance
should run, on the Mac Mini.

Install or upgrade the agent relay on the Mac Mini with
`task agent-relay:install`. Its launchd label is
`com.priori.agent-relay`; uninstalling preserves staged bundles and logs.

### Python Environment

| Task                            | Description                       |
| ------------------------------- | --------------------------------- |
| `task python:setup-all`         | Setup complete Python environment |
| `task python:setup-uv`          | Setup UV Python package manager   |

### Shell Configuration

| Task                      | Description                         |
| ------------------------- | ----------------------------------- |
| `task shell:setup`        | Complete shell setup                |
| `task shell:aliases`      | Install tracked aliases and functions |
| `task shell:copy-aliases` | Compatibility name for `shell:aliases` |

#### Custom Secrets

You can use `.secrets-custom` for your own environment variables.

## ⚙️ Configuration

### Portable Pi

Keep stable Pi defaults, keybindings, and TUI extensions in
`config/pi/agent/`.
Run this once per machine after pulling updates:

```bash
cd ~/Documents/sean-machine-setup
task pi:setup
```

`~/.pi/agent/settings.json` remains a normal local file, so changing Pi's model,
provider, thinking level, or changelog state never dirties this repository.
Tracked extensions are linked individually into `~/.pi/agent/extensions/`, so
other machine-local extensions can coexist. Authentication, model catalogs,
sessions, and trust decisions also remain machine-local.

Edit `config/variables.yml` to customize:

- Working directories
- GitHub user information
- Repository list
- Python version
- Tool versions
- Feature flags

## 🛠️ Installed Tools

After running the complete setup, you'll have:

### Package Managers

- **Bun** - Fast JavaScript runtime & package manager
- **fnm** - Fast Node Manager with Node.js LTS
- **UV** - Modern Python package manager
- **Cargo** - Rust package manager

### Development Tools

- **Git** - Version control with custom aliases
- **vim** - Text editor
- **tmux** - Terminal multiplexer
- **Sesh** - Interactive tmux session manager
- **ripgrep** - Fast text search
- **loc** - Lines of code counter
- **Ruff** - Python linter/formatter
- **PostgreSQL client tools** - `pg_dump`, `pg_restore`, and `psql` for bounded ETL promotion workflows
- **zsh** - Shell with oh-my-zsh framework

### AI Tools (if available)

- **Claude Code CLI** - Anthropic's coding assistant
- **OpenAI Codex CLI** - OpenAI's coding assistant
- **Google Gemini CLI** - Google's coding assistant
- **AI Commit (`cm`)** - Local AI-powered commit message generator using OpenRouter API

### Interactive Menus

- `tm` / `task-menu.zsh` - Fuzzy-search Taskfile tasks and place one at the prompt
- `dd` / `dev-task-menu.zsh` - Fuzzy-find `task dev:*` commands and place one at the prompt
- `rn` / `jf` / `package-menu.zsh` - Browse `package.json` scripts and run them with Bun
- `ff` / `commit-menu.zsh` - Pick a standard commit message, stage changes, and commit
- `tmx` / `tmux-menu.zsh` - Browse, preview, create, attach to, and kill tmux sessions
- `cj` / `repo-menu.zsh` - Jump to an internal or client repo with a grouped native Zsh picker

### Small CLI utility convention

Small local command wrappers and interactive pickers should default to an
executable Zsh script. Start with `#!/bin/zsh -f`, use `emulate -L zsh`, disable
aliases, and call external tools with explicit arguments. Use arrow keys plus
J/K for navigation, Enter for the primary action, and Q or Escape to quit.

When a picker returns a value to its calling shell, render its interface on
stderr and reserve stdout for the result, as `repo-menu.zsh` does. Destructive
actions must operate on the visibly selected item and use an exact target; the
tmux picker uses immutable session IDs for this reason.

Use the existing Bun/TypeScript tooling stack when a utility needs structured
data, APIs, concurrency, reusable modules, or substantial tests. Repo-family
commands should use the shared terminal UI package and conventions documented
in `core-repo/docs/TERMINAL_OUTPUT.md`. Python is not the default runtime for
new small shell pickers.

### Sesh session manager

Run `sesh picker --tmux` to fuzzy-filter active tmux sessions and connect to the
selection. Type to filter, use the arrow keys or Ctrl+J/Ctrl+K to navigate,
press Enter to connect, and Escape or Ctrl+C to cancel. Useful direct commands
include `sesh list --tmux`, `sesh connect <session>`, and `sesh last`.

The `tmx` picker names new sessions after the current directory and adds a
numeric suffix when another session already uses that name. Its session rows
show the active command, working directory, recent activity, attachment state,
and window count. Press `n` to create a session for the current directory or
`p` to toggle the selected session's pane preview. In Ghostty, press `Cmd+L`
to leave a tmux session and return to the calling shell. The Ghostty
profile includes Homebrew's Zsh completion directory, so `sesh` commands and
flags can be explored with Tab completion after opening a new shell.

### Isolated Ghostty profile

Run `task ghostty:setup` on macOS to install Ghostty, ensure Fira Code is
available, and render the versioned profile from `config/ghostty/` into
`~/.config/ghostty/`. The task is safe to rerun after changing the tracked
configuration. If it finds an unmanaged Ghostty config, it saves a timestamped
backup before replacing it.

The profile uses a lean, isolated Zsh setup, so iTerm continues to use the
normal `~/.zshrc`. It shares existing secrets, aliases, functions, and command
history, but does not load Oh My Zsh. It includes:

- Display-P3 light and dark themes based on macOS Appearance
- Fira Code at 16 pt, 95% background opacity, and a compact Git prompt
- Full-strength colors in both focused and unfocused split panes
- History autosuggestions with Tab to accept and Option+Right to accept a word
- Automatic Ghostty terminfo setup and safe fallback for SSH sessions
- Current-directory tab titles that foreground tools can temporarily replace
- No close confirmation for running processes
- New tabs and windows always starting in `~/Documents/core-repo`

To use a different default checkout directory during installation:

```bash
GHOSTTY_WORKING_DIRECTORY="$HOME/path/to/core-repo" task ghostty:setup
```

### macOS Appearance switcher

Run `task theme-switcher:setup` to install the managed Hammerspoon profile and
add an icon-only Appearance control to the macOS menu bar. It uses an outlined
sun for Light, a crescent moon for Dark, and a half-filled circle for Automatic.
Its menu provides Light, Dark, Automatic, and Toggle actions. Ghostty follows
the selected system Appearance through its paired themes. The setup also
preserves Ctrl+Space for switching between U.S. English and Traditional Chinese
input, assigns macOS's standalone Fn/Globe action to Do Nothing so third-party
dictation apps can use it, and ensures Hammerspoon launches at login.

The same profile adds a compact 14×14 chip icon with the current CPU percentage
and a RAM percentage, both updated every three seconds. Their menus show detailed
CPU and memory usage plus shortcuts to Activity Monitor.

## 🤖 AI-Powered Git Commits

The setup includes a local AI commit command that generates meaningful commit messages from your changes.

### Usage

Simply run `cm` in any git repository:

```bash
# Make some changes
echo "new feature" >> file.txt

# Commit with AI-generated message
cm
```

The command will:

1. 📦 Add all changes with `git add .`
2. 🔍 Analyze the diff
3. 🤖 Generate a conventional commit message using AI
4. ✅ Commit with the generated message

### Configuration

The `cm` command uses environment variables (set in `.secrets`):

- `AI_COMMIT_OPENROUTER_API_KEY` - Your OpenRouter API key (required)
- `AI_COMMIT_OPENROUTER_MODEL` - Model to use (default: `google/gemini-2.0-flash-exp:free`)

### Features

- ✨ Colored output for better readability
- 🎯 Focuses on significant changes
- 📝 Uses conventional commit format (feat/fix/refactor/docs/etc.)
- 🚀 Excludes lock files and generated content
- ⚡ Fast and runs completely locally (no GitHub Actions required)

### Available Models

You can use any model from OpenRouter. Some good options:

- `google/gemini-2.0-flash-exp:free` (default, free)
- `anthropic/claude-3.5-sonnet`
- `openai/gpt-4-turbo`
- `meta-llama/llama-3.3-70b-instruct`

Change the model by updating `AI_COMMIT_OPENROUTER_MODEL` in `.secrets`.

## 🔧 Customization

### Custom Git Aliases

Edit `scripts/git-config.sh` to add more git aliases or modify existing ones.

### Shell Customization

Shell shortcuts have one tracked entry point: `shell/init.sh`. Setup links it to
`~/.bash_aliases`, and Bash and Zsh source that link. Put each kind of shortcut
in its designated file:

- `shell/aliases.sh` — all sourced aliases, organized by topic
- `shell/functions.sh` — small sourced functions and wrappers such as `dd` and `cj`
- Root `*.zsh` files — executable interactive pickers and larger terminal tools
- `scripts/shell-config.sh` — installation, oh-my-zsh, plugins, and generated shell configuration only

Do not add shortcuts directly to `.zshrc`, `.bashrc`, `setup.sh`, or the
compatibility shims in `bash/aliases.sh` and `scripts/task-aliases.sh`.

After making a change, run:

```bash
task check
task shell:aliases
```

The install task only needs to be rerun if the checkout moves or the link is
missing. Edits to the tracked files are available in each new shell.

Edit `scripts/shell-config.sh` only to:

- Change oh-my-zsh theme
- Add/remove zsh plugins
- Change non-shortcut shell initialization

### Adding New Tools

1. Add installation function to `scripts/install-tools.sh`
2. Add task to `Taskfile.yml`
3. Update documentation

## 🐛 Troubleshooting

### Task command not found

Install Task runner first (see Prerequisites)

### Permission denied errors

Some tasks may require sudo. Run with: `sudo -E task <task-name>`

### Repository cloning fails

- For private repos: Set `GITHUB_TOKEN` environment variable
- For SSH: Ensure SSH keys are configured with GitHub

### Shell not changing to zsh

After running `task shell:set-default`, log out and back in
