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

# Load tracked machine shortcuts
if [ -r "$HOME/.bash_aliases" ]; then
    source "$HOME/.bash_aliases"
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

# fnm (Fast Node Manager)
if command -v fnm &> /dev/null; then
    eval "$(fnm env --use-on-cd)"
fi

# Rust/Cargo
if [ -d "$HOME/.cargo" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# UV (Python package manager) - cache on /workspace for hardlinking support
if [ -d "/workspace" ]; then
    export UV_CACHE_DIR="/workspace/.uv-cache"
fi

# HuggingFace - cache on /workspace to avoid filling container disk
if [ -d "/workspace" ]; then
    export HF_HOME="/workspace/.cache/huggingface"
fi

# End of .zshrc
EOF
    
    log_info ".zshrc configured successfully! ✅"
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

# Install the single tracked shortcut entry point.
install_shortcuts() {
    log_info "Installing tracked shell shortcuts..."

    local shell_config_directory shell_config_repo_root shortcut_entry
    local shortcut_rc shortcut_source
    shell_config_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    shell_config_repo_root="$(dirname "$shell_config_directory")"
    shortcut_entry="$shell_config_repo_root/shell/init.sh"

    if [ ! -f "$shortcut_entry" ]; then
        log_error "shell/init.sh not found in repository"
        return 1
    fi

    rm -f "$HOME/.bash_aliases"
    ln -s "$shortcut_entry" "$HOME/.bash_aliases"

    shortcut_source='[ -r "$HOME/.bash_aliases" ] && . "$HOME/.bash_aliases"'
    for shortcut_rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -f "$shortcut_rc" ] && ! grep -Fq '.bash_aliases' "$shortcut_rc"; then
            printf '\n# Tracked machine shortcuts\n%s\n' "$shortcut_source" >> "$shortcut_rc"
            log_info "Added the tracked shortcut source to $shortcut_rc"
        fi
    done

    log_info "Shortcuts linked: ~/.bash_aliases -> $shortcut_entry ✅"
    log_info "Edit shell/aliases.sh or shell/functions.sh; changes load in new shells"
}

# Backward-compatible name used by older task invocations.
copy_aliases_to_home() {
    install_shortcuts
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
    
    # Install tracked shortcuts
    install_shortcuts

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
    log_info "  - install_shortcuts     : Install tracked aliases and functions"
    log_info "  - copy_aliases_to_home  : Compatibility name for install_shortcuts"
    log_info "  - set_default_shell     : Set zsh as default shell"
    log_info "  - setup_tmux_config     : Link tmux config to home"
    log_info "  - setup_zsh_complete    : Complete zsh setup"
    exit 1
fi

# Execute the requested function
"$@"
