#!/bin/bash

# Shell configuration script (zsh, oh-my-zsh, plugins)
# Source utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

# Install oh-my-zsh
install_ohmyzsh() {
    log_info "Installing oh-my-zsh..."
    
    if [ -d "$HOME/.oh-my-zsh" ]; then
        log_warn "oh-my-zsh already installed"
        return 0
    fi
    
    # Install oh-my-zsh unattended
    log_info "Downloading and installing oh-my-zsh..."
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
    
    log_info "oh-my-zsh installed successfully! ✅"
}

# Install zsh plugins
install_zsh_plugins() {
    log_info "Installing zsh plugins..."
    
    # Install zsh-autosuggestions
    if [ ! -d "$HOME/.zsh/zsh-autosuggestions" ]; then
        log_info "Installing zsh-autosuggestions..."
        git clone https://github.com/zsh-users/zsh-autosuggestions ~/.zsh/zsh-autosuggestions
    else
        log_warn "zsh-autosuggestions already installed"
    fi
    
    # Install zsh-syntax-highlighting (via git if not installed via package)
    if [ ! -d "$HOME/.zsh/zsh-syntax-highlighting" ] && [ ! -f "/usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]; then
        log_info "Installing zsh-syntax-highlighting..."
        git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ~/.zsh/zsh-syntax-highlighting
    else
        log_warn "zsh-syntax-highlighting already available"
    fi
    
    # Install zsh-completions
    if [ ! -d "$HOME/.oh-my-zsh/custom/plugins/zsh-completions" ]; then
        log_info "Installing zsh-completions..."
        git clone https://github.com/zsh-users/zsh-completions ~/.oh-my-zsh/custom/plugins/zsh-completions
    else
        log_warn "zsh-completions already installed"
    fi
    
    log_info "Zsh plugins installed successfully! ✅"
}

# Configure .zshrc
configure_zshrc() {
    log_info "Configuring .zshrc..."
    
    # Backup existing .zshrc if it exists
    if [ -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.zshrc.backup" ]; then
        log_info "Backing up existing .zshrc..."
        cp "$HOME/.zshrc" "$HOME/.zshrc.backup"
    fi
    
    # Create comprehensive .zshrc
    cat > "$HOME/.zshrc" << 'EOF'
# ZSH Configuration File
# WARNING: This file contains Zsh-specific syntax!
# Only source this file from a Zsh shell, never from Bash.

# Guard: Prevent sourcing in non-zsh shells
if [ -z "$ZSH_VERSION" ]; then
    echo "⚠️  Error: .zshrc should only be sourced in Zsh, not $SHELL"
    echo "   To switch to zsh, run: zsh"
    echo "   To make zsh your default shell, run: chsh -s $(which zsh)"
    return 1 2>/dev/null || exit 1
fi

# Path to your oh-my-zsh installation
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load
ZSH_THEME="robbyrussell"

# Uncomment to use case-sensitive completion
# CASE_SENSITIVE="true"

# Uncomment to use hyphen-insensitive completion
# HYPHEN_INSENSITIVE="true"

# Uncomment to disable bi-weekly auto-update checks
# DISABLE_AUTO_UPDATE="true"

# Uncomment to change how often to auto-update (in days)
# export UPDATE_ZSH_DAYS=13

# Which plugins would you like to load?
# Note: docker, docker-compose, and tmux plugins are commented out
# Uncomment them if you install the corresponding tools
plugins=(
    git
    # docker          # Uncomment if docker is installed
    # docker-compose  # Uncomment if docker-compose is installed
    npm
    node
    python
    pip
    virtualenv
    rust
    tmux
    z
    colored-man-pages
    command-not-found
    extract
    sudo
)

# Load oh-my-zsh
source $ZSH/oh-my-zsh.sh

# Load secrets file if it exists (for API keys, etc.)
# Must be loaded BEFORE prompt configuration to allow prompt customization
if [ -f ~/.secrets ]; then
    set -a  # automatically export all variables
    source ~/.secrets
    set +a  # turn off auto-export
fi

# Load custom secrets file if it exists
if [ -f ~/.secrets-custom ]; then
    set -a  # automatically export all variables
    source ~/.secrets-custom
    set +a  # turn off auto-export
fi

# User configuration

# Export PATH
# Prioritize Homebrew binaries (fixes Python version issues)
# Detect if using Apple Silicon (/opt/homebrew) or Intel (/usr/local)
if [ -d "/opt/homebrew/bin" ]; then
    export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/bin:$HOME/.local/bin:$PATH"
elif [ -d "/usr/local/bin" ]; then
    export PATH="/usr/local/bin:/usr/local/sbin:$HOME/bin:$HOME/.local/bin:$PATH"
else
    export PATH="$HOME/bin:$HOME/.local/bin:$PATH"
fi

# Preferred editor for local and remote sessions
if [[ -n $SSH_CONNECTION ]]; then
    export EDITOR='vim'
else
    export EDITOR='vim'
fi

# Compilation flags
export ARCHFLAGS="-arch x86_64"

# Enable CSS build pre-commit hook
export ENABLE_BUILD_CSS_PRE_COMMIT_HOOK="true"

# Load custom functions
if [ -f ~/.zsh_functions ]; then
    source ~/.zsh_functions
fi

# Load custom aliases
if [ -f ~/.zsh_aliases ]; then
    source ~/.zsh_aliases
fi

# Load local configuration if it exists
if [ -f ~/.zshrc.local ]; then
    source ~/.zshrc.local
fi

# Plugin configurations

# zsh-autosuggestions
if [ -f ~/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh ]; then
    source ~/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh
    # Bind tab to accept suggestion
    bindkey '\t' end-of-line
    # Set suggestion strategy
    ZSH_AUTOSUGGEST_STRATEGY=(history completion)
    ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20
fi

# zsh-syntax-highlighting (must be last)
if [ -f /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]; then
    source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
elif [ -f ~/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]; then
    source ~/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
fi

# Tool integrations

# Bun
if [ -d "$HOME/.bun" ]; then
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

# NVM (Node Version Manager)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Rust/Cargo
if [ -d "$HOME/.cargo" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# Auto-source aliases before each prompt (allows dynamic alias updates)
# Aliases are stored in ~/.bash_aliases (copied during setup)
precmd() {
    if [ -f "$HOME/.bash_aliases" ]; then
        source "$HOME/.bash_aliases"
    fi
}

# Custom functions

# ============================================
# AI-Powered Git Commit Functions
# ============================================

# Local AI commit command (using OpenRouter API)
cm() {
    # Check if we're in a git repository
    if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
        echo "\033[31m❌ Not in a git repository\033[0m"
        return 1
    fi

    # Check for API key
    local API_KEY="${AI_COMMIT_OPENROUTER_API_KEY:-${OPENROUTER_API_KEY}}"
    if [ -z "$API_KEY" ]; then
        echo "\033[31m❌ API key not set (AI_COMMIT_OPENROUTER_API_KEY or OPENROUTER_API_KEY)\033[0m"
        return 1
    fi

    # Set default model if not set
    local MODEL="${AI_COMMIT_OPENROUTER_MODEL:-google/gemini-2.5-flash}"
    
    # Add all changes
    echo "\033[36m📦 Adding all changes...\033[0m"
    git add .
    
    # Check if there are changes to commit
    if git diff --cached --quiet; then
        echo "\033[33m⚠️  No changes staged\033[0m"
        return 1
    fi
    
    # Show what will be committed
    git status --short
    echo ""
    
    # Get diff (excluding lock files, limiting to 500 lines)
    DIFF_TEXT=$(git diff --cached --diff-filter=AMR | \
        grep -v "package-lock.json\|yarn.lock\|pnpm-lock.yaml\|bun.lockb\|poetry.lock\|Pipfile.lock\|\.min\.js\|\.min\.css" | \
        head -n 500)
    
    # Generate commit message using OpenRouter API
    echo "\033[36m🤖 Generating commit message...\033[0m"
    
    RESPONSE=$(echo "$DIFF_TEXT" | API_KEY="$API_KEY" python3 -c "
import json, sys, urllib.request, os

diff = sys.stdin.read()
data = {
    'model': '$MODEL',
    'messages': [
        {'role': 'system', 'content': 'Write a concise git commit message using conventional commit format (feat/fix/refactor/docs/test/chore). Be technical and specific.'},
        {'role': 'user', 'content': f'Generate a commit message for this diff:\\n\\n{diff}'}
    ],
    'max_tokens': 150,
    'temperature': 0.7
}

req = urllib.request.Request(
    'https://openrouter.ai/api/v1/chat/completions',
    data=json.dumps(data).encode('utf-8'),
    headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {os.environ[\"API_KEY\"]}'}
)

with urllib.request.urlopen(req) as response:
    result = json.loads(response.read())
    print(result['choices'][0]['message']['content'].strip().strip('\`'))
" 2>&1)
    
    if [ $? -ne 0 ]; then
        echo "\033[31m❌ API call failed:\033[0m"
        echo "$RESPONSE"
        return 1
    fi
    
    # Display and commit
    echo ""
    echo "\033[32m✨ $RESPONSE\033[0m"
    echo ""
    
    if git commit -m "$RESPONSE"; then
        echo "\033[32m✅ Committed successfully!\033[0m"
    else
        echo "\033[31m❌ Commit failed\033[0m"
        return 1
    fi
}

# Ripgrep with exclusions
rp() {
    rg -g '!{**/node_modules/*,**/.git/*,**/dist/*,**/public/*,**/build/*}' -F "$@"
}

# Make directory and cd into it
mkcd() {
    mkdir -p "$1" && cd "$1"
}

# Extract various archive formats
extract() {
    if [ -f "$1" ]; then
        case "$1" in
            *.tar.bz2)   tar xjf "$1"     ;;
            *.tar.gz)    tar xzf "$1"     ;;
            *.bz2)       bunzip2 "$1"     ;;
            *.rar)       unrar e "$1"     ;;
            *.gz)        gunzip "$1"      ;;
            *.tar)       tar xf "$1"      ;;
            *.tbz2)      tar xjf "$1"     ;;
            *.tgz)       tar xzf "$1"     ;;
            *.zip)       unzip "$1"       ;;
            *.Z)         uncompress "$1"  ;;
            *.7z)        7z x "$1"        ;;
            *)     echo "'$1' cannot be extracted via extract()" ;;
        esac
    else
        echo "'$1' is not a valid file"
    fi
}

# Git branch cleanup - remove merged branches
git-cleanup() {
    git branch --merged | grep -v '\*\|main\|master\|development' | xargs -n 1 git branch -d
}

# Find and replace in files
find-replace() {
    if [ $# -ne 2 ]; then
        echo "Usage: find-replace 'search' 'replace'"
        return 1
    fi
    rg -l "$1" | xargs sed -i "s/$1/$2/g"
}

# Show path entries one per line
path() {
    echo $PATH | tr ':' '\n'
}

# Quick backup of a file
backup() {
    cp "$1" "$1.backup.$(date +%Y%m%d_%H%M%S)"
}

# export AI_COMMIT_OPENROUTER_API_KEY="<your-api-key>"

# End of .zshrc
EOF
    
    log_info ".zshrc configured successfully! ✅"
}

# Create custom aliases file
create_aliases_file() {
    log_info "Creating custom aliases file..."
    
    cat > "$HOME/.zsh_aliases" << 'EOF'
# Custom Zsh Aliases

# Navigation
alias home='cd ~'
alias root='cd /'
alias desk='cd ~/Desktop'
alias docs='cd ~/Documents'
alias downs='cd ~/Downloads'
alias work='cd /workspace'

# Safety nets
alias rm='rm -i'
alias cp='cp -i'
alias mv='mv -i'
alias mkdir='mkdir -pv'

# Improved commands
alias df='df -H'
alias du='du -ch'
alias free='free -m'
alias top='htop || top'
alias vi='vim'

# Network
alias ports='netstat -tulanp'
alias listen='lsof -i -P | grep LISTEN'
alias ping='ping -c 5'

# System info
alias meminfo='free -m -l -t'
alias psmem='ps auxf | sort -nr -k 4 | head -10'
alias pscpu='ps auxf | sort -nr -k 3 | head -10'
alias cpuinfo='lscpu'

# Development
alias serve='python -m http.server 8000'
alias json='python -m json.tool'
alias timestamp='date +%s'
alias uuid='uuidgen | tr "[:upper:]" "[:lower:]"'

# Cleanup
alias clean-ds='find . -type f -name "*.DS_Store" -ls -delete'
alias clean-pyc='find . -type f -name "*.pyc" -exec rm -f {} +'
alias clean-npm='rm -rf node_modules package-lock.json && npm install'
alias clean-docker='docker system prune -af'
EOF
    
    log_info "Custom aliases file created! ✅"
}

# Create custom functions file
create_functions_file() {
    log_info "Creating custom functions file..."
    
    cat > "$HOME/.zsh_functions" << 'EOF'
# Custom Zsh Functions

# Create a new Python virtual environment and activate it
mkvenv() {
    local name="${1:-venv}"
    python -m venv "$name" && source "$name/bin/activate"
}

# Quick git commit with message (renamed to avoid conflict with oh-my-zsh git plugin)
qgc() {
    git add -A && git commit -m "$*"
}

# Git push to current branch
gpc() {
    git push origin $(git branch --show-current)
}

# Search history
hist() {
    history | grep "$1"
}

# Kill process by name
killp() {
    ps aux | grep -v grep | grep "$1" | awk '{print $2}' | xargs kill -9
}

# Show disk usage of current directory
duh() {
    du -sh * | sort -rh | head -20
}

# Create and enter a temporary directory
tmpd() {
    cd $(mktemp -d)
}

# Show most used commands
most-used() {
    history | awk '{print $2}' | sort | uniq -c | sort -rn | head -20
}

# Docker container shell
dsh() {
    docker exec -it "$1" /bin/bash || docker exec -it "$1" /bin/sh
}

# Show git log with graph for last n commits (renamed to avoid conflict with oh-my-zsh git plugin)
gitlog() {
    local n="${1:-20}"
    git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit -n "$n"
}
EOF
    
    log_info "Custom functions file created! ✅"
}

# Set zsh as default shell
set_default_shell() {
    log_info "Setting zsh as default shell..."
    
    if ! command_exists zsh; then
        log_error "zsh is not installed. Please install zsh first."
        return 1
    fi
    
    ZSH_PATH=$(which zsh)
    
    # Add zsh to /etc/shells if not already there
    if ! grep -q "^$ZSH_PATH$" /etc/shells 2>/dev/null; then
        log_info "Adding $ZSH_PATH to /etc/shells..."
        
        # Use sudo only if not root and sudo is available
        if ! echo "$ZSH_PATH" | run_privileged tee -a /etc/shells > /dev/null 2>&1; then
            log_warn "Could not write to /etc/shells"
            log_warn "You may need to manually add $ZSH_PATH to /etc/shells"
        fi
    fi
    
    # Set as default shell for current user
    if command_exists chsh; then
        log_info "Changing default shell to zsh for user $(whoami)..."
        chsh -s "$ZSH_PATH" || log_warn "Could not set zsh as default shell automatically"
        
        # Also update for root if we are root
        if [ "$EUID" -eq 0 ]; then
            log_info "Setting zsh as default shell for root user..."
            usermod -s "$ZSH_PATH" root || log_warn "Could not set zsh for root via usermod"
        fi
        
        log_info "Default shell changed to zsh! ✅"
        log_info "Note: You'll need to log out and back in for the change to take effect"
    else
        log_warn "chsh command not found. Please manually set your shell to: $ZSH_PATH"
    fi
}

# Link aliases file from repository to home directory
copy_aliases_to_home() {
    log_info "Linking aliases file from repository..."

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(dirname "$SCRIPT_DIR")"

    if [ -f "$REPO_ROOT/bash/aliases.sh" ]; then
        # Remove existing file or symlink
        rm -f "$HOME/.bash_aliases"

        # Create symlink to repo file
        ln -s "$REPO_ROOT/bash/aliases.sh" "$HOME/.bash_aliases"

        log_info "Aliases linked: ~/.bash_aliases -> $REPO_ROOT/bash/aliases.sh ✅"
        log_info "Edit $REPO_ROOT/bash/aliases.sh and changes take effect immediately"
        log_info "Updates from git pull will be reflected automatically"
    else
        log_warn "bash/aliases.sh not found in repository"
    fi
}

# Link tmux config file from repository to home directory
setup_tmux_config() {
    log_info "Setting up tmux configuration..."

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(dirname "$SCRIPT_DIR")"

    if [ -f "$REPO_ROOT/.tmux.conf" ]; then
        # Remove existing file or symlink
        rm -f "$HOME/.tmux.conf"

        # Create symlink to repo file
        ln -s "$REPO_ROOT/.tmux.conf" "$HOME/.tmux.conf"

        log_info "tmux config linked: ~/.tmux.conf -> $REPO_ROOT/.tmux.conf ✅"
        log_info "Edit $REPO_ROOT/.tmux.conf and changes take effect on new tmux sessions"
    else
        log_warn ".tmux.conf not found in repository"
    fi
}

# Complete zsh setup
setup_zsh_complete() {
    log_info "Starting complete zsh setup..."
    
    # Check if zsh is installed
    if ! command_exists zsh; then
        log_error "zsh is not installed. Please install zsh first with: apt install zsh"
        return 1
    fi
    
    # Install oh-my-zsh
    install_ohmyzsh

    # Install plugins
    install_zsh_plugins
    
    # Configure .zshrc
    configure_zshrc
    
    # Create custom files
    create_aliases_file
    create_functions_file
    
    # Copy aliases to home directory
    copy_aliases_to_home

    # Setup tmux configuration
    setup_tmux_config

    log_info "Zsh setup completed successfully! ✅"
    log_info "Features enabled:"
    log_info "  • oh-my-zsh framework"
    log_info "  • zsh-autosuggestions (tab to accept)"
    log_info "  • zsh-syntax-highlighting"
    log_info "  • Custom aliases and functions"
    log_info "  • Git, Docker, Python, Node.js plugins"
    log_info ""
    log_info "🎨 Theme configuration:"
    log_info "   The default theme is robbyrussell (classic oh-my-zsh theme)"
    log_info ""
    log_info "🔥 To start using zsh now, run: zsh"
    log_info "   Or make zsh your default shell: task shell:set-default"
    log_info ""
}

# Main execution
if [ $# -eq 0 ]; then
    log_error "No function specified. Usage: $0 <function_name>"
    log_info "Available functions:"
    log_info "  - install_ohmyzsh       : Install oh-my-zsh"
    log_info "  - install_zsh_plugins   : Install zsh plugins"
    log_info "  - configure_zshrc       : Configure .zshrc file"
    log_info "  - create_aliases_file   : Create custom aliases"
    log_info "  - create_functions_file : Create custom functions"
    log_info "  - set_default_shell     : Set zsh as default shell"
    log_info "  - setup_tmux_config     : Link tmux config to home"
    log_info "  - setup_zsh_complete    : Complete zsh setup"
    exit 1
fi

# Execute the requested function
"$@"
