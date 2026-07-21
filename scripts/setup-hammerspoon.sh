#!/bin/bash

# Hammerspoon setup script (macOS only)
# Installs a managed input-source hotkey and Appearance menu-bar switcher.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

# Guard: macOS only
if [ "$(uname)" != "Darwin" ]; then
    log_warn "Hammerspoon setup is only available on macOS; skipping."
    exit 0
fi

find_brew() {
    if [[ -x /opt/homebrew/bin/brew ]]; then
        printf '%s\n' /opt/homebrew/bin/brew
    elif [[ -x /usr/local/bin/brew ]]; then
        printf '%s\n' /usr/local/bin/brew
    elif command_exists brew; then
        command -v brew
    else
        return 1
    fi
}

brew_bin="$(find_brew || true)"
brew_command=("$brew_bin")
if [[ "$brew_bin" == "/opt/homebrew/bin/brew" ]] && \
   [[ "$(uname -m)" == "x86_64" ]] && \
   [[ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" == "1" ]]; then
    brew_command=(arch -arm64 "$brew_bin")
fi

install_hammerspoon() {
    log_info "Installing Hammerspoon..."

    if [[ -z "$brew_bin" ]]; then
        log_error "Homebrew is required. Install it first: https://brew.sh"
        return 1
    fi

    if "${brew_command[@]}" list --cask hammerspoon &>/dev/null; then
        log_info "Hammerspoon is already installed"
    else
        "${brew_command[@]}" install --cask hammerspoon
    fi

    log_info "Hammerspoon is installed."
}

configure_hammerspoon() {
    log_info "Installing the managed Hammerspoon configuration..."

    ensure_directory "$HOME/.hammerspoon"

    local config_file="$HOME/.hammerspoon/init.lua"
    local config_src="$SCRIPT_DIR/../config/hammerspoon-init.lua"
    local managed_marker="-- Managed by sean-machine-setup."

    if [ ! -f "$config_src" ]; then
        log_error "Config source not found: $config_src"
        return 1
    fi

    if [[ -L "$config_file" ]]; then
        unlink "$config_file"
    elif [[ -f "$config_file" ]] && ! grep -Fq -- "$managed_marker" "$config_file"; then
        local backup="$config_file.backup.$(date +%Y%m%d%H%M%S)"
        cp -p "$config_file" "$backup"
        log_warn "Saved the previous Hammerspoon config to $backup"
    fi

    install -m 0644 "$config_src" "$config_file"
    log_info "Hammerspoon configuration installed."
}

# Compatibility entry point retained for existing setup commands.
configure_input_toggle() {
    configure_hammerspoon
}

ensure_login_item() {
    if osascript -e 'tell application "System Events" to exists login item "Hammerspoon"' \
        2>/dev/null | grep -Fxq true; then
        log_info "Hammerspoon already launches at login."
        return
    fi

    osascript -e 'tell application "System Events" to make login item at end with properties {name:"Hammerspoon", path:"/Applications/Hammerspoon.app", hidden:true}' >/dev/null
    log_info "Hammerspoon will launch at login."
}

configure_fn_for_dictation() {
    defaults write com.apple.HIToolbox AppleFnUsageType -int 0

    local user_id process_name
    user_id="$(id -u)"
    for process_name in TextInputSwitcher TextInputMenuAgent cfprefsd; do
        pkill -x -u "$user_id" "$process_name" 2>/dev/null || true
    done

    log_info "Fn/Globe key reserved for third-party dictation shortcuts."
}

reload_hammerspoon() {
    if pgrep -x Hammerspoon >/dev/null 2>&1; then
        # Lua execution over AppleScript is intentionally disabled by default
        # in Hammerspoon, so restart the app to load the managed configuration.
        osascript -e 'tell application "Hammerspoon" to quit' >/dev/null
        for _ in {1..20}; do
            pgrep -x Hammerspoon >/dev/null 2>&1 || break
            sleep 0.1
        done
    fi

    open -gja Hammerspoon
    log_info "Hammerspoon launched with the managed configuration."
}

show_input_sources() {
    log_info "Listing enabled input sources..."
    defaults read ~/Library/Preferences/com.apple.HIToolbox.plist AppleEnabledInputSources 2>/dev/null
}

setup_all() {
    install_hammerspoon
    configure_hammerspoon
    configure_fn_for_dictation
    ensure_login_item
    reload_hammerspoon
}

# Main execution
if [ $# -eq 0 ]; then
    log_error "No function specified. Usage: $0 <function_name>"
    log_info "Available functions:"
    log_info "  - install_hammerspoon   : Install Hammerspoon via Homebrew"
    log_info "  - configure_hammerspoon  : Install the managed Hammerspoon config"
    log_info "  - configure_input_toggle: Alias for configure_hammerspoon"
    log_info "  - configure_fn_for_dictation: Disable macOS Fn input switching"
    log_info "  - ensure_login_item      : Launch Hammerspoon automatically at login"
    log_info "  - reload_hammerspoon     : Apply the installed configuration"
    log_info "  - show_input_sources    : List enabled macOS input sources"
    log_info "  - setup_all             : Install and configure everything"
    exit 1
fi

"$@"
