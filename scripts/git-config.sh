#!/bin/bash

# Git configuration script
# Source utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

# Load variables from Taskfile if available
if [ -f "$SCRIPT_DIR/../config/variables.yml" ]; then
    # Extract variables from YAML (basic parsing)
    GITHUB_EMAIL=$(grep "GITHUB_EMAIL:" "$SCRIPT_DIR/../config/variables.yml" | awk '{print $2}')
    GITHUB_NAME=$(grep "GITHUB_NAME:" "$SCRIPT_DIR/../config/variables.yml" | awk '{print $2}')
else
    # Fallback defaults
    GITHUB_EMAIL="${GITHUB_EMAIL:-sean.smith.2009@gmail.com}"
    GITHUB_NAME="${GITHUB_NAME:-Sean}"
fi

# Setup basic git configuration
setup_config() {
    log_info "Setting up git configuration..."
    
    # Set user information
    git config --global user.email "$GITHUB_EMAIL"
    git config --global user.name "$GITHUB_NAME"
    
    # Set default branch name
    git config --global init.defaultbranch main
    
    # Enable auto-setup of remote tracking
    git config --global push.autosetupremote true
    
    # Set default pull strategy - Always rebase on pull
    git config --global pull.rebase true
    
    # Enable color output
    git config --global color.ui auto
    
    # Set default editor (vim if available)
    if command_exists vim; then
        git config --global core.editor vim
    fi
    
    log_info "Git configuration setup successfully! ✅"
}

# Setup git aliases
setup_aliases() {
    log_info "Setting up git aliases..."
    
    # Status and info aliases
    git config --global alias.st status
    git config --global alias.s 'status -s'
    git config --global alias.b branch
    git config --global alias.br 'branch -r'
    git config --global alias.ba 'branch -a'
    
    # Commit aliases
    git config --global alias.c commit
    git config --global alias.cm 'commit -m'
    git config --global alias.ca 'commit --amend'
    git config --global alias.acm '!git add -A && git commit -m'
    
    # Checkout and branch management
    git config --global alias.co checkout
    git config --global alias.cob 'checkout -b'
    git config --global alias.com 'checkout main'
    git config --global alias.cod 'checkout development'
    git config --global alias.d 'branch -D'
    git config --global alias.bs branch-select
    
    # Push and pull aliases
    git config --global alias.p push
    git config --global alias.ps 'push --set-upstream origin'
    git config --global alias.pf 'push --force-with-lease'
    git config --global alias.pl pull
    git config --global alias.f fetch
    git config --global alias.fa 'fetch --all'
    
    # Diff aliases
    git config --global alias.df diff
    git config --global alias.dfs 'diff --staged'
    git config --global alias.dfc 'diff --cached'
    
    # Log aliases
    git config --global alias.l 'log --oneline --graph --decorate'
    git config --global alias.la 'log --oneline --graph --decorate --all'
    git config --global alias.ll 'log --pretty=format:"%C(yellow)%h%Cred%d %Creset%s%Cblue [%cn]" --decorate --numstat'
    git config --global alias.last 'log -1 HEAD'
    
    # Stash aliases
    git config --global alias.sh stash
    git config --global alias.shp 'stash pop'
    git config --global alias.shl 'stash list'
    git config --global alias.nuke '!git stash && git stash clear'
    
    # Reset aliases
    git config --global alias.unstage 'reset HEAD --'
    git config --global alias.undo 'reset HEAD~1 --mixed'
    git config --global alias.hard 'reset --hard'
    
    # Remote aliases
    git config --global alias.rv 'remote -v'
    git config --global alias.ra 'remote add'
    
    # Cleanup aliases
    git config --global alias.cleanup '!git branch --merged | grep -v "\\*\\|main\\|master\\|development" | xargs -n 1 git branch -d'
    git config --global alias.prune 'fetch --prune'
    
    # Show aliases
    git config --global alias.aliases '!git config --get-regexp alias | sort'
    
    log_info "Git aliases setup successfully! ✅"
}

# Setup SSH key for GitHub
setup_ssh_key() {
    log_info "Setting up SSH key for GitHub..."
    
    SSH_KEY_PATH="$HOME/.ssh/id_ed25519"
    
    # Check if SSH key already exists
    if [ -f "$SSH_KEY_PATH" ]; then
        log_warn "SSH key already exists at $SSH_KEY_PATH"
        log_info "Public key:"
        cat "${SSH_KEY_PATH}.pub"
        return 0
    fi
    
    # Generate new SSH key
    log_info "Generating new ED25519 SSH key..."
    ssh-keygen -t ed25519 -C "$GITHUB_EMAIL" -f "$SSH_KEY_PATH" -N ""
    
    # Start ssh-agent and add key
    log_info "Adding SSH key to ssh-agent..."
    eval "$(ssh-agent -s)"
    ssh-add "$SSH_KEY_PATH"
    
    # Display public key
    log_info "SSH key generated successfully! ✅"
    log_info "Add this public key to your GitHub account:"
    echo ""
    cat "${SSH_KEY_PATH}.pub"
    echo ""
    log_info "Go to: https://github.com/settings/keys"
    
    # Add GitHub to known hosts
    log_info "Adding GitHub to known hosts..."
    ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
}

# Setup GitHub CLI authentication
setup_gh_auth() {
    log_info "Setting up GitHub CLI authentication..."
    
    # Check if gh is installed
    if ! command_exists gh; then
        log_error "GitHub CLI (gh) is not installed. Please install it first."
        return 1
    fi
    
    # Check if already authenticated
    if gh auth status &>/dev/null; then
        log_info "GitHub CLI is already authenticated ✅"
        gh auth status
        return 0
    fi
    
    # Setup SSH authentication
    log_info "Setting up GitHub CLI with SSH authentication..."
    log_info "You will be prompted to authenticate with GitHub."
    log_info "Choose SSH as your preferred protocol when asked."
    
    # Run gh auth login with SSH preference
    gh auth login --git-protocol ssh
    
    # Verify authentication
    if gh auth status &>/dev/null; then
        log_info "GitHub CLI authentication successful! ✅"
        gh auth status
    else
        log_error "GitHub CLI authentication failed"
        return 1
    fi
}

# Setup git credential helper (deprecated in favor of gh CLI)
setup_credential_helper() {
    log_info "Setting up git credential helper..."
    log_warn "Consider using 'gh auth login' instead for better GitHub integration"
    
    # Use credential.helper store for simplicity (stores in plaintext)
    # For more security, use credential-manager or keychain on macOS
    git config --global credential.helper store
    
    # Set credential helper timeout (in seconds)
    git config --global credential.helper 'cache --timeout=3600'
    
    log_info "Git credential helper configured! ✅"
}

# Show current git configuration
show_config() {
    log_info "Current git configuration:"
    echo ""
    echo "User Configuration:"
    echo "  Name: $(git config --global user.name)"
    echo "  Email: $(git config --global user.email)"
    echo ""
    echo "Core Configuration:"
    echo "  Default branch: $(git config --global init.defaultbranch)"
    echo "  Editor: $(git config --global core.editor)"
    echo "  Credential helper: $(git config --global credential.helper)"
    echo ""
    echo "Aliases configured: $(git config --get-regexp alias | wc -l)"
    echo ""
    echo "Run 'git aliases' to see all configured aliases"
}

# Setup everything
setup_all() {
    setup_config
    setup_aliases
    setup_ssh_key
    setup_gh_auth
    show_config
}

# Main execution
if [ $# -eq 0 ]; then
    log_error "No function specified. Usage: $0 <function_name>"
    log_info "Available functions:"
    log_info "  - setup_config      : Setup basic git configuration"
    log_info "  - setup_aliases     : Setup git aliases"
    log_info "  - setup_ssh_key     : Generate SSH key for GitHub"
    log_info "  - setup_gh_auth     : Setup GitHub CLI authentication with SSH"
    log_info "  - setup_credential_helper : Setup credential storage (deprecated)"
    log_info "  - show_config       : Show current configuration"
    log_info "  - setup_all         : Run all setup functions"
    exit 1
fi

# Execute the requested function
"$@"
