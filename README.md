# Sean Machine Setup Scripts

Bootstrap scripts for setting up development environments with all necessary tools and configurations.

## 📋 Prerequisites

### Required Tools

1. **GitHub CLI** - For managing repositories

   ```bash
   bash scripts/install-gh.sh

   gh auth login
   ```

2. **Task** - Task runner (required to run the setup)

   ```bash
   sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin
   ```

3. **Git** - For cloning repositories (if not already installed)
   ```bash
   sudo apt install git
   ```

## 🚀 Quick Start

```bash
# Clone this repository
cd sean-machine-setup

# Run complete setup (installs everything)
task

# Or run specific setup tasks
task full-setup    # Quick setup without heavy installations
```

## 📝 Available Tasks

### Main Tasks

| Task                     | Description                                                    |
| ------------------------ | -------------------------------------------------------------- |
| `task` or `task default` | Complete machine setup - installs all tools and configurations |
| `task quick-setup`       | Quick setup without heavy installations                        |
| `task help`              | Show all available tasks                                       |
| `task clean`             | Clean up temporary files and caches                            |

### Git Configuration

| Task               | Description                         |
| ------------------ | ----------------------------------- |
| `task git:setup`   | Setup git configuration and aliases |
| `task git:aliases` | Setup git aliases only              |
| `task git:config`  | Setup git configuration only        |

### Repository Management

| Task                                     | Description                       |
| ---------------------------------------- | --------------------------------- |
| `task repos:clone-all`                   | Clone all configured repositories |
| `task repos:clone-single REPO_URL=<url>` | Clone a single repository         |

### System Dependencies

| Task                         | Description                 |
| ---------------------------- | --------------------------- |
| `task system:install-deps`   | Install system dependencies |

### Development Tools

| Task                     | Description                         |
| ------------------------ | ----------------------------------- |
| `task tools:install-all` | Install all development tools       |
| `task tools:bun`         | Install Bun JavaScript runtime      |
| `task tools:nvm-node`    | Install nvm and Node.js LTS         |
| `task tools:rust`        | Install Rust and Cargo              |
| `task tools:loc`         | Install loc (lines of code counter) |
| `task tools:ai-cli`      | Install AI CLI tools                |

### Coding Agents

| Task                       | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `task coding-agents:update` | Update Claude, Codex, and Gemini CLIs to their latest versions |

### Python Environment

| Task                            | Description                       |
| ------------------------------- | --------------------------------- |
| `task python:setup-all`         | Setup complete Python environment |
| `task python:setup-uv`          | Setup UV Python package manager   |

### Shell Configuration

| Task                      | Description                         |
| ------------------------- | ----------------------------------- |
| `task shell:setup`        | Complete shell setup                |
| `task shell:copy-aliases` | Copy aliases file to home directory |

#### Custom Secrets

You can use `.secrets-custom` for your own environment variables.

## ⚙️ Configuration

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
- **nvm** - Node Version Manager with Node.js LTS
- **UV** - Modern Python package manager
- **Cargo** - Rust package manager

### Development Tools

- **Git** - Version control with custom aliases
- **vim** - Text editor
- **tmux** - Terminal multiplexer
- **ripgrep** - Fast text search
- **loc** - Lines of code counter
- **Ruff** - Python linter/formatter
- **zsh** - Shell with oh-my-zsh framework

### AI Tools (if available)

- **Claude Code CLI** - Anthropic's coding assistant
- **OpenAI Codex CLI** - OpenAI's coding assistant
- **Google Gemini CLI** - Google's coding assistant
- **AI Commit (`cm`)** - Local AI-powered commit message generator using OpenRouter API

### Interactive Menus

- `tm` / `task-menu-fast.py` - Browse and run Taskfile tasks with arrow keys
- `run` / `package-menu.py` - Browse `package.json` scripts and run them with Bun
- `tmx` / `tmux-menu.py` - Browse tmux sessions and attach with a single keypress

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

Edit `scripts/shell-config.sh` to:

- Change oh-my-zsh theme
- Add/remove zsh plugins
- Modify functions

Edit `bash/aliases.sh` in the repository:

- Aliases are symlinked from `bash/aliases.sh` to `~/.bash_aliases`
- Changes to the repo file take effect immediately on next prompt
- Aliases work in both bash and zsh
- Updates from `git pull` are automatically reflected
- If you move the repo, run `task shell:copy-aliases` to update the symlink

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

## 📄 License

MIT License - See LICENSE file for details

## 🤝 Contributing

Pull requests are welcome! Please ensure:

1. Scripts follow existing patterns
2. New tasks are documented
3. Functions are added to appropriate script files
4. Variables are configurable via `config/variables.yml`
