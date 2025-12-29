#!/bin/bash

# Tool installation functions
# Source utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

# Install Bun JavaScript runtime
install_bun() {
    log_info "Installing Bun..."
    
    if command_exists bun; then
        log_warn "Bun is already installed"
        bun --version
        return 0
    fi
    
    # Install Bun
    log_info "Downloading and installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    
    # Add Bun to PATH for current session
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    # Add to shell configurations
    add_to_shell_rc 'export BUN_INSTALL="$HOME/.bun"' "Bun installation directory"
    add_to_path '$BUN_INSTALL/bin' "Bun"
    
    # Verify installation
    verify_installation "Bun" "bun"
}

# Install nvm and Node.js
install_nvm_and_node() {
    log_info "Installing nvm and Node.js..."
    
    export NVM_DIR="$HOME/.nvm"
    
    # Check if nvm is already installed
    if [ -d "$NVM_DIR" ]; then
        log_warn "nvm directory already exists, checking installation..."
        # Source nvm
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
        
        if command_exists nvm; then
            log_info "nvm is already installed ✅"
            nvm --version
        fi
    else
        # Install nvm
        log_info "Downloading and installing nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
        
        # Source nvm for current session
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    fi
    
    # Add nvm to shell configurations
    add_to_shell_rc 'export NVM_DIR="$HOME/.nvm"' "NVM directory"
    add_source_to_shell_rc '$NVM_DIR/nvm.sh' '-s' "nvm"
    add_source_to_shell_rc '$NVM_DIR/bash_completion' '-s' "nvm bash completion"
    
    # Install latest LTS Node.js
    log_info "Installing Node.js LTS..."
    # Source nvm again to make sure it's available
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    
    # Install and use latest LTS
    nvm install --lts
    nvm use --lts
    
    # Set default to the current version (which is now the LTS version)
    local node_version=$(nvm current)
    if [ "$node_version" != "none" ] && [ -n "$node_version" ]; then
        nvm alias default "$node_version"
    else
        log_warn "Could not determine current Node.js version to set as default"
    fi
    
    # Verify installations
    verify_installation "Node.js" "node"
    verify_installation "npm" "npm"
}

# Install GitHub CLI
install_gh_cli() {
    log_info "Installing GitHub CLI (gh)..."
    
    if command_exists gh; then
        log_warn "GitHub CLI is already installed"
        gh --version
        return 0
    fi
    
    # Install GitHub CLI
    log_info "Downloading and installing GitHub CLI..."
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt update
    apt install gh -y
    
    # Verify installation
    verify_installation "GitHub CLI" "gh"
}

# Install AI CLI tools
install_ai_cli_tools() {
    log_info "Installing AI CLI tools..."
    
    # Make sure npm is available
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    
    if ! command_exists npm; then
        log_error "npm is not available. Please ensure Node.js is installed first."
        return 1
    fi
    
    # Install Claude Code CLI (if it exists)
    log_info "Installing Claude Code CLI..."
    if npm list -g @anthropic-ai/claude-code &>/dev/null; then
        log_warn "Claude Code CLI is already installed globally"
    else
        npm install -g @anthropic-ai/claude-code 2>/dev/null || \
            log_warn "Claude Code CLI package not found or requires authentication"
    fi
    
    # Install OpenAI Codex CLI (if it exists)
    log_info "Installing OpenAI Codex CLI..."
    if npm list -g @openai/codex &>/dev/null; then
        log_warn "OpenAI Codex CLI is already installed globally"
    else
        npm install -g @openai/codex 2>/dev/null || \
            log_warn "OpenAI Codex CLI package not found or requires authentication"
    fi

    # Install Google Gemini CLI (if it exists)
    log_info "Installing Google Gemini CLI..."
    if npm list -g @google/gemini-cli &>/dev/null; then
        log_warn "Google Gemini CLI is already installed globally"
    else
        npm install -g @google/gemini-cli 2>/dev/null || \
            log_warn "Google Gemini CLI package not found or requires authentication"
    fi
    
    log_info "AI CLI tools installation completed!"
}

# Update AI CLI tools to the latest version
update_ai_cli_tools() {
    log_info "Updating AI CLI tools to the latest versions..."

    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

    if ! command_exists npm; then
        log_error "npm is not available. Please ensure Node.js is installed first."
        return 1
    fi

    echo "Installing latest version of Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code@latest
    echo "Installing latest version of OpenAI Codex CLI..."
    npm install -g @openai/codex@latest
    echo "Installing latest version of Google Gemini CLI..."
    npm install -g @google/gemini-cli@latest

    log_info "AI CLI tools updated!"
}

# Install Rust
install_rust() {
    log_info "Installing Rust..."
    
    if command_exists rustc; then
        log_warn "Rust is already installed"
        rustc --version
        cargo --version
        return 0
    fi
    
    # Install Rust using rustup
    log_info "Downloading and installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    
    # Add Rust to PATH for current session
    export PATH="$HOME/.cargo/bin:$PATH"
    
    # Add to shell configurations
    add_to_path '$HOME/.cargo/bin' "Rust/Cargo"
    
    # Verify installation
    verify_installation "Rust" "rustc"
    verify_installation "Cargo" "cargo"
}

# Install loc (lines of code counter)
install_loc() {
    log_info "Installing loc (lines of code counter)..."
    
    # Make sure cargo is available
    export PATH="$HOME/.cargo/bin:$PATH"
    
    if ! command_exists cargo; then
        log_error "cargo is not available. Please ensure Rust is installed first."
        return 1
    fi
    
    # Check if loc is already installed
    if command_exists loc; then
        log_warn "loc is already installed"
        loc --version 2>/dev/null || echo "loc (version check not supported)"
        return 0
    fi
    
    log_info "Installing loc via cargo..."
    cargo install loc
    
    verify_installation "loc" "loc" "--version"
}

# Install jq (JSON processor)
install_jq() {
    log_info "Installing jq..."

    if command_exists jq; then
        log_warn "jq is already installed"
        jq --version
        return 0
    fi

    # Detect OS and install accordingly
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command_exists brew; then
            log_info "Installing jq via Homebrew..."
            brew install jq
        else
            log_error "Homebrew not found. Please install Homebrew first: https://brew.sh"
            return 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if command_exists apt-get; then
            log_info "Installing jq via apt..."
            run_privileged apt-get update
            run_privileged apt-get install -y jq
        else
            log_error "apt-get not found. This script supports apt-based distributions."
            return 1
        fi
    else
        log_error "Unsupported OS: $OSTYPE"
        return 1
    fi

    # Verify installation
    verify_installation "jq" "jq"
}

# Install Biome (JavaScript/TypeScript formatter and linter)
install_biome() {
    log_info "Installing Biome..."
    
    # Make sure npm is available
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    
    if ! command_exists npm; then
        log_error "npm is not available. Please ensure Node.js is installed first."
        return 1
    fi
    
    # Check if Biome is already installed
    if npm list -g @biomejs/biome &>/dev/null; then
        log_warn "Biome is already installed globally"
        npm list -g @biomejs/biome --depth=0
        return 0
    fi
    
    # Install Biome globally
    log_info "Installing Biome via npm..."
    npm install -g @biomejs/biome
    
    # Verify installation
    if command_exists biome; then
        log_info "Biome installed successfully! ✅"
        biome --version
    else
        log_warn "Biome installation completed but command not found. You may need to restart your shell."
    fi
}

# Install all tools
install_all() {
    install_bun
    install_nvm_and_node
    install_rust
    install_loc
    install_ai_cli_tools
    install_jq
    install_biome
}

# Main execution
if [ $# -eq 0 ]; then
    log_error "No function specified. Usage: $0 <function_name>"
    log_info "Available functions:"
    log_info "  - install_bun"
    log_info "  - install_nvm_and_node"
    log_info "  - install_rust"
    log_info "  - install_loc"
    log_info "  - install_ai_cli_tools"
    log_info "  - update_ai_cli_tools"
    log_info "  - install_jq"
    log_info "  - install_biome"
    log_info "  - install_all"
    exit 1
fi

# Execute the requested function
"$@"
