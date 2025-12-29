#!/bin/bash

# Common utility functions for setup scripts

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

log_debug() {
    if [ "${DEBUG:-0}" = "1" ]; then
        echo -e "${BLUE}[DEBUG]${NC} $1"
    fi
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Add line to file if not already present
add_to_file_if_missing() {
    local file="$1"
    local line="$2"
    local description="${3:-configuration}"
    
    if [ ! -f "$file" ]; then
        log_debug "Creating $file"
        touch "$file"
    fi
    
    if ! grep -Fxq "$line" "$file"; then
        log_debug "Adding $description to $file"
        echo "$line" >> "$file"
        return 0
    else
        log_debug "$description already in $file"
        return 1
    fi
}

# Add to shell RC files (both bash and zsh if they exist)
add_to_shell_rc() {
    local line="$1"
    local description="${2:-configuration}"
    
    local added=0
    
    # Add to bashrc
    if add_to_file_if_missing "$HOME/.bashrc" "$line" "$description"; then
        added=1
    fi
    
    # Add to zshrc if it exists
    if [ -f "$HOME/.zshrc" ]; then
        if add_to_file_if_missing "$HOME/.zshrc" "$line" "$description"; then
            added=1
        fi
    fi
    
    return $added
}

# Add PATH export to shell RC files
add_to_path() {
    local path_dir="$1"
    local description="${2:-$path_dir}"
    
    local export_line="export PATH=\"$path_dir:\$PATH\""
    add_to_shell_rc "$export_line" "PATH for $description"
}

# Source a script in shell RC files
add_source_to_shell_rc() {
    local script_path="$1"
    local condition="${2:-}"
    local description="${3:-$script_path}"
    
    local source_line
    if [ -n "$condition" ]; then
        source_line="[ -s \"$script_path\" ] && . \"$script_path\""
    else
        source_line="source \"$script_path\""
    fi
    
    add_to_shell_rc "$source_line" "source $description"
}

# Check if running as root
is_root() {
    [ "$EUID" -eq 0 ]
}

# Run command with sudo if needed (not root and sudo is available)
# Usage: $(maybe_sudo) apt-get install -y package
maybe_sudo() {
    if [ "$EUID" -eq 0 ]; then
        # Already root, no sudo needed
        echo ""
    elif command -v sudo >/dev/null 2>&1; then
        # Not root but sudo is available
        echo "sudo"
    else
        # Not root and no sudo - run as-is and hope for the best
        echo ""
    fi
}

# Run a command with sudo only if needed
# Usage: run_privileged apt-get install -y package
run_privileged() {
    local sudo_cmd=$(maybe_sudo)
    if [ -n "$sudo_cmd" ]; then
        $sudo_cmd "$@"
    else
        "$@"
    fi
}

# Ensure script is run with bash
ensure_bash() {
    if [ -z "$BASH_VERSION" ]; then
        log_error "This script must be run with bash"
        exit 1
    fi
}

# Create directory if it doesn't exist
ensure_directory() {
    local dir="$1"
    if [ ! -d "$dir" ]; then
        log_debug "Creating directory: $dir"
        mkdir -p "$dir"
    fi
}

# Download file with retry
download_with_retry() {
    local url="$1"
    local output="$2"
    local max_retries="${3:-3}"
    local retry_delay="${4:-5}"
    
    for i in $(seq 1 $max_retries); do
        log_debug "Download attempt $i of $max_retries: $url"
        
        if wget -q -O "$output" "$url" || curl -fsSL "$url" -o "$output"; then
            log_debug "Successfully downloaded: $url"
            return 0
        fi
        
        if [ $i -lt $max_retries ]; then
            log_warn "Download failed, retrying in ${retry_delay}s..."
            sleep $retry_delay
        fi
    done
    
    log_error "Failed to download after $max_retries attempts: $url"
    return 1
}

# Clone git repository with GitHub CLI or git
clone_repository() {
    local repo_url="$1"
    local target_dir="$2"
    
    # Extract repository name if target_dir not provided
    if [ -z "$target_dir" ]; then
        target_dir=$(basename "$repo_url" .git)
    fi
    
    # Check if already cloned
    if [ -d "$target_dir/.git" ]; then
        log_warn "Repository already exists: $target_dir"
        return 0
    fi
    
    # Use gh CLI if available and authenticated for GitHub repos
    if command_exists gh && gh auth status &>/dev/null && [[ "$repo_url" == git@github.com:* ]]; then
        # Extract owner/repo from URL for gh repo clone
        local repo_path=$(echo "$repo_url" | sed 's/git@github.com://' | sed 's/\.git$//')
        log_info "Cloning with GitHub CLI: $target_dir"
        gh repo clone "$repo_path" "$target_dir" -- --recurse-submodules
    else
        # Fallback to regular git clone
        log_info "Cloning with git: $target_dir"
        git clone "$repo_url" "$target_dir"
    fi
}

# Verify tool installation
verify_installation() {
    local tool_name="$1"
    local command_name="${2:-$tool_name}"
    local version_flag="${3:---version}"
    
    if command_exists "$command_name"; then
        log_info "$tool_name installed successfully! ✅"
        $command_name $version_flag 2>/dev/null || echo "$tool_name (version check failed)"
        return 0
    else
        log_warn "$tool_name installation completed but not found in PATH"
        log_warn "You may need to restart your shell or source your shell configuration"
        return 1
    fi
}

# Add shell configuration header
add_shell_header() {
    local file="$1"
    local shell_type="${2:-bash}"
    
    if [ ! -f "$file" ] || ! grep -q "WARNING: This file contains" "$file"; then
        local header
        if [ "$shell_type" = "bash" ]; then
            header="# BASH Configuration File
# WARNING: This file contains Bash-specific syntax!
# Only source this file from a Bash shell, never from Zsh.
# To check your current shell: echo \$SHELL or echo \$0
"
        else
            header="# ZSH Configuration File
# WARNING: This file contains Zsh-specific syntax!
# Only source this file from a Zsh shell, never from Bash.
# To check your current shell: echo \$SHELL or echo \$0
"
        fi
        
        if [ -f "$file" ]; then
            # Prepend header to existing file
            echo "$header" | cat - "$file" > "$file.tmp" && mv "$file.tmp" "$file"
        else
            echo "$header" > "$file"
        fi
    fi
}

# Note: Functions are available when this script is sourced
# No need to export them as we're sourcing the script directly
