#!/bin/bash

set -e  # Exit on any error

# Configuration variables
WORKING_DIRECTORY="/root"
CODE_DIRECTORY="/workspace"
GITHUB_USER="bonham000"
GITHUB_EMAIL="sean.smith.2009@gmail.com"
GITHUB_NAME="Sean"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Setup GitHub info
setup_github_info() {
    log_info "Setting up GitHub info..."
    cd "$WORKING_DIRECTORY"
    git config --global user.email "sean.smith.2009@gmail.com"
    git config --global user.name "bonham000"
    
    # Setup git aliases
    log_info "Setting up git aliases..."
    git config --global alias.st status
    git config --global alias.b branch
    git config --global alias.acm '!git add -A && git commit -m'
    git config --global alias.ps 'push --set-upstream origin'
    git config --global alias.f fetch
    git config --global alias.pl pull
    git config --global alias.p push
    git config --global alias.d 'branch -D'
    git config --global alias.bs branch-select
    git config --global alias.nuke '!git stash && git stash clear'
    
    # Setup git configuration
    log_info "Setting up git configuration..."
    git config --global push.autosetupremote true
    git config --global init.defaultbranch main
    
    log_info "GitHub info setup successfully! ✅"
}

# Clone repositories
clone_repositories() {
    log_info "Cloning repositories..."
    
    # Create code directory if it doesn't exist
    mkdir -p "$CODE_DIRECTORY"
    cd "$CODE_DIRECTORY"
    
    # Loop through each repository
    for repo in "${REPOS_TO_CLONE[@]}"; do
        # Extract repository name from URL
        # Format: git@github.com:org/repo.git -> repo
        repo_name=$(basename "$repo" .git)
        
        # Check if repository already exists
        if [ -d "$CODE_DIRECTORY/$repo_name" ]; then
            log_warn "Repository $repo_name already exists at $CODE_DIRECTORY/$repo_name, skipping..."
        else
            log_info "Cloning $repo_name..."
            if git clone "$repo" "$CODE_DIRECTORY/$repo_name"; then
                log_info "Successfully cloned $repo_name ✅"
            else
                log_error "Failed to clone $repo_name"
                log_warn "This might be due to SSH key issues. Make sure your SSH key is configured with GitHub."
            fi
        fi
    done
    
    log_info "Repository cloning completed!"
}

# Install system dependencies
install_dependencies() {
    log_info "Installing system dependencies..."
    apt-get update -y && apt upgrade -y
    apt install unzip tmux cuda-toolkit-12-6 zsh zsh-syntax-highlighting ripgrep vim -y

}

# Install Bun
install_bun() {
    log_info "Installing Bun..."
    
    # Check if Bun is already installed
    if command_exists bun; then
        log_warn "Bun is already installed, checking version..."
        bun --version
        return 0
    fi
    
    # Install Bun
    log_info "Downloading and installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    
    # Add Bun to PATH for current session
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    # Add Bun to bashrc if not already there
    if ! grep -q "export BUN_INSTALL=" ~/.bashrc; then
        # Add safety header if bashrc doesn't exist or doesn't have it
        if [ ! -f "$HOME/.bashrc" ] || ! grep -q "WARNING: This file contains Bash-specific syntax" ~/.bashrc; then
            echo '# BASH Configuration File' >> ~/.bashrc
            echo '# WARNING: This file contains Bash-specific syntax!' >> ~/.bashrc
            echo '# Only source this file from a Bash shell, never from Zsh.' >> ~/.bashrc
            echo '# To check your current shell: echo $SHELL or echo $0' >> ~/.bashrc
            echo '' >> ~/.bashrc
        fi
        echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
        echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
    fi
    
    # Add Bun to zshrc if zsh is installed
    if [ -f "$HOME/.zshrc" ]; then
        if ! grep -q "export BUN_INSTALL=" ~/.zshrc; then
            echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.zshrc
            echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.zshrc
        fi
    fi
    
    # Verify installation
    if command_exists bun; then
        log_info "Bun installed successfully! ✅"
        bun --version
    else
        log_warn "Bun installation completed but not found in PATH. You may need to restart your shell."
    fi
}

# Install fnm and Node.js
install_fnm_and_node() {
    log_info "Installing fnm and Node.js..."

    if command_exists fnm; then
        log_info "fnm is already installed ✅"
        fnm --version
    else
        if [[ "$OSTYPE" == "darwin"* ]]; then
            brew install fnm
        else
            curl -fsSL https://fnm.vercel.app/install | bash
        fi
    fi

    # Load fnm for current session
    eval "$(fnm env --use-on-cd)"

    # Install and set default Node.js LTS
    log_info "Installing Node.js LTS..."
    fnm install --lts
    fnm default lts-latest

    # Verify installations
    verify_installation "fnm" "fnm"
    verify_installation "Node.js" "node"
    verify_installation "npm" "npm"
}

# Install AI CLI tools (Claude Code and Codex)
install_ai_cli_tools() {
    log_info "Installing AI CLI tools..."
    
    # Make sure npm is available
    command -v fnm &> /dev/null && eval "$(fnm env)"
    
    if ! command_exists npm; then
        log_error "npm is not available. Please ensure Node.js is installed first."
        return 1
    fi
    
    # Install Claude Code CLI
    log_info "Installing Claude Code CLI..."
    if npm list -g @anthropic-ai/claude-code &>/dev/null; then
        log_warn "Claude Code CLI is already installed globally"
        npm list -g @anthropic-ai/claude-code --depth=0
    else
        npm install -g @anthropic-ai/claude-code
        if [ $? -eq 0 ]; then
            log_info "Claude Code CLI installed successfully! ✅"
        else
            log_warn "Failed to install Claude Code CLI. Package might not exist or require authentication."
        fi
    fi
    
    # Install OpenAI Codex CLI
    log_info "Installing OpenAI Codex CLI..."
    if npm list -g @openai/codex &>/dev/null; then
        log_warn "OpenAI Codex CLI is already installed globally"
        npm list -g @openai/codex --depth=0
    else
        npm install -g @openai/codex
        if [ $? -eq 0 ]; then
            log_info "OpenAI Codex CLI installed successfully! ✅"
        else
            log_warn "Failed to install OpenAI Codex CLI. Package might not exist or require authentication."
        fi
    fi

    # Install Google Gemini CLI
    log_info "Installing Google Gemini CLI..."
    if npm list -g @google/gemini-cli &>/dev/null; then
        log_warn "Google Gemini CLI is already installed globally"
        npm list -g @google/gemini-cli --depth=0
    else
        npm install -g @google/gemini-cli
        if [ $? -eq 0 ]; then
            log_info "Google Gemini CLI installed successfully! ✅"
        else
            log_warn "Failed to install Google Gemini CLI. Package might not exist or require authentication."
        fi
    fi
    
    log_info "AI CLI tools installation completed!"
}

# Install Rust and loc
install_rust_and_loc() {
    log_info "Installing Rust and loc..."
    
    # Check if Rust is already installed
    if command_exists rustc; then
        log_warn "Rust is already installed, checking version..."
        rustc --version
        cargo --version
    else
        # Install Rust using rustup
        log_info "Downloading and installing Rust..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        
        # Add Rust to PATH for current session
        export PATH="$HOME/.cargo/bin:$PATH"
        
        # Add Rust to bashrc if not already there
        if ! grep -q "export PATH=\"\$HOME/.cargo/bin:\$PATH\"" ~/.bashrc; then
            # Add safety header if bashrc doesn't exist or doesn't have it
            if [ ! -f "$HOME/.bashrc" ] || ! grep -q "WARNING: This file contains Bash-specific syntax" ~/.bashrc; then
                echo '# BASH Configuration File' >> ~/.bashrc
                echo '# WARNING: This file contains Bash-specific syntax!' >> ~/.bashrc
                echo '# Only source this file from a Bash shell, never from Zsh.' >> ~/.bashrc
                echo '# To check your current shell: echo $SHELL or echo $0' >> ~/.bashrc
                echo '' >> ~/.bashrc
            fi
            echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc
        fi
        
        # Add Rust to zshrc if zsh is installed
        if [ -f "$HOME/.zshrc" ]; then
            if ! grep -q "export PATH=\"\$HOME/.cargo/bin:\$PATH\"" ~/.zshrc; then
                echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.zshrc
            fi
        fi
        
        # Verify Rust installation
        if command_exists rustc; then
            log_info "Rust installed successfully! ✅"
            rustc --version
            cargo --version
        else
            log_warn "Rust installation completed but not found in PATH. You may need to restart your shell."
        fi
    fi
    
    # Install loc using cargo
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
        loc --version || echo "loc version check failed"
    else
        log_info "Installing loc via cargo..."
        cargo install loc
        
        if command_exists loc; then
            log_info "loc installed successfully! ✅"
            loc --version || echo "loc version check failed"
        else
            log_warn "loc installation completed but not found in PATH. You may need to restart your shell."
        fi
    fi
    
    log_info "Rust and loc installation completed!"
}

# Install rclone
install_rclone() {
    log_info "Installing rclone..."

    if command_exists rclone; then
        log_warn "rclone is already installed"
        rclone --version | head -1
        return 0
    fi

    # Detect OS and install accordingly
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command_exists brew; then
            log_info "Installing rclone via Homebrew..."
            brew install rclone
        else
            log_info "Installing rclone via official script..."
            curl https://rclone.org/install.sh | bash
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux - use official script for latest version
        log_info "Installing rclone via official script..."
        curl https://rclone.org/install.sh | bash
    else
        log_error "Unsupported OS: $OSTYPE"
        return 1
    fi

    # Verify installation
    if command_exists rclone; then
        log_info "rclone installed successfully! ✅"
        rclone --version | head -1
    else
        log_warn "rclone installation completed but not found in PATH. You may need to restart your shell."
    fi
}

# Setup UV environment
setup_uv_environment() {
    log_info "Setting up uv environment..."

    # Install uv if not already installed
    if ! command_exists uv; then
        log_info "Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
        # uv installer adds to PATH, but ensure it's available for this session
        export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
    else
        log_info "uv is already installed ✅"
        uv --version
    fi

    # Ensure uv is in PATH for this session
    export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

    log_info "Installing Ruff..."
    uv tool install ruff@latest

    log_info "UV environment setup successfully! ✅"
}

# Decrypt secrets
decrypt_secrets() {
    log_info "Decrypting secrets..."
    
    if [ -z "$SECRETS_PASSWORD" ]; then
        log_error "SECRETS_PASSWORD environment variable is not set"
        echo -e "\nPlease export SECRETS_PASSWORD before running this script"
        echo -e "\nExample: \n\nexport SECRETS_PASSWORD=your_password"
        return 1  # Changed from exit 1 to return 1 to allow script to continue
    fi
    
    # Also check in the sean-machine-setup directory (where this script is located)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$SCRIPT_DIR"
    if [ -f "secrets.enc" ]; then
        log_info "Decrypting secrets from sean-machine-setup..."
        openssl enc -aes-256-cbc -salt -d -in secrets.enc -out .secrets -k "$SECRETS_PASSWORD" 2>/dev/null
        if [ $? -eq 0 ]; then
            log_info "Secrets decrypted successfully! ✅"
        else
            log_error "Failed to decrypt secrets.enc - check your password"
            return 1
        fi
    fi
}


# Delegate shell setup to the maintained implementation.
setup_zsh_and_ohmyzsh() {
    bash "$SCRIPT_DIR/scripts/shell-config.sh" setup_zsh_complete
    bash "$SCRIPT_DIR/scripts/shell-config.sh" set_default_shell
}

# Copy secrets files to home directory
copy_secrets_to_home() {
    log_info "Copying secrets files to home directory..."

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    # Copy .secrets if it exists
    if [ -f "$SCRIPT_DIR/.secrets" ]; then
        cp "$SCRIPT_DIR/.secrets" "$HOME/.secrets"
        log_info "Copied .secrets to home directory ✅"
    else
        log_warn ".secrets not found in repository (run decrypt_secrets first)"
    fi

    # Copy .secrets-custom if it doesn't exist in home directory
    if [ ! -f "$HOME/.secrets-custom" ] && [ -f "$SCRIPT_DIR/.secrets-custom" ]; then
        cp "$SCRIPT_DIR/.secrets-custom" "$HOME/.secrets-custom"
        log_info "Copied .secrets-custom template to home directory ✅"
        log_info "Edit ~/.secrets-custom to add your custom environment variables"
    elif [ -f "$HOME/.secrets-custom" ]; then
        log_info ".secrets-custom already exists in home directory ✅"
    else
        log_warn ".secrets-custom template not found in repository"
    fi
}

# Main execution
main() {
    log_info "Starting bootstrap process..."

    # Create necessary directories
    mkdir -p "$CODE_DIRECTORY"

    # Run setup tasks
    setup_github_info
    clone_repositories
    
    # Only decrypt if SECRETS_PASSWORD is set
    if [ -n "$SECRETS_PASSWORD" ]; then
        decrypt_secrets
    else
        log_warn "SECRETS_PASSWORD not set, skipping secret decryption steps"
    fi

    # Copy secrets files to home directory (after decryption)
    copy_secrets_to_home

    install_dependencies
    install_bun
    install_fnm_and_node
    install_ai_cli_tools
    install_rust_and_loc
    install_rclone
    setup_uv_environment
    setup_zsh_and_ohmyzsh

    log_info ""
    log_info "Bootstrap completed successfully! ✅"
    log_info ""
    log_info "Switching to zsh and loading configuration..."
    
    # Switch to zsh and source the configuration
    if command_exists zsh && [ -f "$HOME/.zshrc" ]; then
        log_info "Starting zsh with loaded configuration..."
        exec zsh -c "source ~/.zshrc; exec zsh"
    else
        log_warn "zsh or .zshrc not found, staying in current shell"
    fi
    
    log_info ""
    log_info "=== Installed Tools ==="
    log_info ""
    log_info "📦 Package Managers:"
    log_info "  • Bun (JavaScript runtime & package manager)"
    log_info "  • fnm with Node.js LTS and npm"
    log_info "  • UV (Python package manager)"
    log_info "  • Rust with Cargo (Rust package manager)"
    log_info ""
    log_info "🔧 Development Tools:"
    log_info "  • Git (configured)"
    log_info "  • vim (text editor)"
    log_info "  • tmux"
    log_info "  • ripgrep (fast text search)"
    log_info "  • loc (lines of code counter)"
    log_info "  • rclone (cloud storage sync)"
    log_info "  • Ruff (Python linter)"
    log_info "  • zsh with oh-my-zsh and plugins"
    log_info ""
    log_info "🤖 AI CLI Tools:"
    log_info "  • Claude Code CLI (@anthropic-ai/claude-code)"
    log_info "  • OpenAI Codex CLI (@openai/codex)"
    log_info "  • Google Gemini CLI (@google/gemini-cli)"
    log_info ""
    log_info "=== Quick Start Commands ==="
    log_info ""
    log_info "Node.js version management:"
    log_info "    fnm list              # List installed versions"
    log_info "    fnm use --lts         # Use LTS version"
    log_info ""
    log_info "Bun commands:"
    log_info "    bun install           # Install dependencies"
    log_info "    bun run <script>      # Run scripts"
    log_info ""
    log_info "Code analysis:"
    log_info "    loc                   # Count lines of code in current directory"
    log_info "    loc /path/to/project  # Count lines in specific directory"
    log_info "    loc --files src       # Show per-file stats for src directory"
    log_info ""
    log_info "=== Shell Configuration ==="
    log_info ""
    log_info "🎉 You're now in zsh with oh-my-zsh and all configurations loaded!"
    log_info ""
    log_info "Your shell has been automatically switched to zsh with:"
    log_info "  • oh-my-zsh framework"
    log_info "  • zsh-autosuggestions (tab to accept suggestions)"
    log_info "  • zsh-syntax-highlighting"
    log_info "  • Custom aliases and functions"
    log_info ""
    log_info "To make zsh your permanent default shell:"
    log_info "    chsh -s $(which zsh)  # Then logout and login again"
}

# Run main function
main "$@"
