#!/bin/bash

# Hammerspoon setup script (macOS only)
# Installs Hammerspoon and configures input source toggle hotkey

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

# Guard: macOS only
if [ "$(uname)" != "Darwin" ]; then
    log_error "This script is macOS only. Exiting."
    exit 1
fi

install_hammerspoon() {
    log_info "Installing Hammerspoon..."

    if ! command_exists brew; then
        log_error "Homebrew is required. Install it first: https://brew.sh"
        return 1
    fi

    if brew list --cask hammerspoon &>/dev/null; then
        log_info "Hammerspoon is already installed"
    else
        brew install --cask hammerspoon
    fi

    verify_installation "Hammerspoon" "open" "-h" || true
    log_info "Hammerspoon installed. Grant it Accessibility permissions in System Settings > Privacy & Security > Accessibility."
}

configure_input_toggle() {
    log_info "Configuring input source toggle hotkey..."

    ensure_directory "$HOME/.hammerspoon"

    local config_file="$HOME/.hammerspoon/init.lua"
    local config_src="$SCRIPT_DIR/../config/hammerspoon-init.lua"

    if [ ! -f "$config_src" ]; then
        log_error "Config source not found: $config_src"
        return 1
    fi

    if [ -f "$config_file" ]; then
        if grep -q "TCIM" "$config_file"; then
            log_info "Input toggle hotkey already configured in init.lua"
            return 0
        fi
        log_warn "Existing init.lua found. Appending input toggle config..."
        echo "" >> "$config_file"
        cat "$config_src" >> "$config_file"
    else
        cp "$config_src" "$config_file"
    fi

    log_info "Input toggle hotkey configured (Ctrl+Space) "
    log_info "Reload Hammerspoon config from the menubar icon or restart the app."
}

show_input_sources() {
    log_info "Listing enabled input sources..."
    defaults read ~/Library/Preferences/com.apple.HIToolbox.plist AppleEnabledInputSources 2>/dev/null
}

setup_all() {
    install_hammerspoon
    configure_input_toggle
}

# Main execution
if [ $# -eq 0 ]; then
    log_error "No function specified. Usage: $0 <function_name>"
    log_info "Available functions:"
    log_info "  - install_hammerspoon   : Install Hammerspoon via Homebrew"
    log_info "  - configure_input_toggle: Configure Ctrl+Space input source toggle"
    log_info "  - show_input_sources    : List enabled macOS input sources"
    log_info "  - setup_all             : Install and configure everything"
    exit 1
fi

"$@"
