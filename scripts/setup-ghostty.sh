#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/utils.sh
source "$SCRIPT_DIR/utils.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
    log_warn "Ghostty setup is only available on macOS; skipping."
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
if [[ -z "$brew_bin" ]]; then
    log_error "Homebrew is required. Run 'task system:install-deps' first."
    exit 1
fi

# A terminal launched from an Intel/Rosetta parent reports x86_64 even when
# Homebrew and the machine are ARM64. Run ARM Homebrew in its native arch.
brew_command=("$brew_bin")
if [[ "$brew_bin" == "/opt/homebrew/bin/brew" ]] && \
   [[ "$(uname -m)" == "x86_64" ]] && \
   [[ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" == "1" ]]; then
    brew_command=(arch -arm64 "$brew_bin")
fi

if "${brew_command[@]}" list --cask ghostty >/dev/null 2>&1; then
    log_info "Ghostty is already installed."
else
    log_info "Installing Ghostty..."
    "${brew_command[@]}" install --cask ghostty
fi

ghostty_bin=""
if [[ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]]; then
    ghostty_bin=/Applications/Ghostty.app/Contents/MacOS/ghostty
elif command_exists ghostty; then
    ghostty_bin="$(command -v ghostty)"
fi

if [[ -z "$ghostty_bin" ]]; then
    log_error "Ghostty was installed but its executable could not be found."
    exit 1
fi

if "$ghostty_bin" +list-fonts 2>/dev/null | grep -Fx "Fira Code" >/dev/null; then
    log_info "Fira Code is already installed."
elif "${brew_command[@]}" list --cask font-fira-code >/dev/null 2>&1; then
    log_info "Fira Code is already installed through Homebrew."
else
    log_info "Installing Fira Code..."
    "${brew_command[@]}" install --cask font-fira-code
fi

config_dir="${GHOSTTY_CONFIG_DIR:-$HOME/.config/ghostty}"
working_directory="${GHOSTTY_WORKING_DIRECTORY:-$HOME/Documents/core-repo}"
zdotdir="$config_dir/zsh"
template="$SETUP_DIR/config/ghostty/config.ghostty.template"
managed_marker="# Managed by sean-machine-setup."

install -d -m 0755 "$config_dir" "$zdotdir"

config_target="$config_dir/config.ghostty"
if [[ -L "$config_target" ]]; then
    unlink "$config_target"
elif [[ -f "$config_target" ]] && ! grep -Fq "$managed_marker" "$config_target"; then
    backup="$config_target.backup.$(date +%Y%m%d%H%M%S)"
    cp -p "$config_target" "$backup"
    log_warn "Saved the previous Ghostty config to $backup"
fi

themes_target="$config_dir/themes"
if [[ -L "$themes_target" ]]; then
    unlink "$themes_target"
fi
install -d -m 0755 "$themes_target"

rendered_config="$(mktemp "${TMPDIR:-/tmp}/ghostty-config.XXXXXX")"
trap 'rm -f "$rendered_config"' EXIT

sed \
    -e "s|__GHOSTTY_ZDOTDIR__|$zdotdir|g" \
    -e "s|__GHOSTTY_WORKING_DIRECTORY__|$working_directory|g" \
    "$template" > "$rendered_config"

install -m 0644 "$rendered_config" "$config_target"
install -m 0644 "$SETUP_DIR/config/ghostty/zsh/.zshenv" "$zdotdir/.zshenv"
install -m 0644 "$SETUP_DIR/config/ghostty/zsh/.zshrc" "$zdotdir/.zshrc"
install -m 0644 \
    "$SETUP_DIR/config/ghostty/themes/Homebrew Custom Dark" \
    "$themes_target/Homebrew Custom Dark"
install -m 0644 \
    "$SETUP_DIR/config/ghostty/themes/Homebrew Custom Light" \
    "$themes_target/Homebrew Custom Light"

if [[ ! -d "$working_directory" ]]; then
    log_warn "Default directory does not exist yet: $working_directory"
fi

"$ghostty_bin" +validate-config --config-file="$config_target"

log_info "Ghostty profile installed in $config_dir"
log_info "New tabs and windows will start in $working_directory"
log_info "Restart Ghostty to apply all settings."
