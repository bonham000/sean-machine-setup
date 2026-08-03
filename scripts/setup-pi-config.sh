#!/bin/bash

# Setup portable Pi configuration from the repository.
# Keybindings and tracked extensions are linked directly. Stable settings
# defaults are merged into a machine-local settings.json so Pi can update model
# and runtime state without dirtying this repository.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

setup_pi_config() {
    local repo_root
    local source_dir
    local target_dir
    local keybindings_source
    local keybindings_target
    local extensions_source
    local extensions_target
    local settings_defaults
    local settings_seed
    local settings_target
    local legacy_settings_source

    repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
    source_dir="$repo_root/config/pi/agent"
    target_dir="$HOME/.pi/agent"
    keybindings_source="$source_dir/keybindings.json"
    keybindings_target="$target_dir/keybindings.json"
    extensions_source="$source_dir/extensions"
    extensions_target="$target_dir/extensions"
    settings_defaults="$source_dir/settings.defaults.json"
    settings_seed="$source_dir/settings.seed.json"
    settings_target="$target_dir/settings.json"
    legacy_settings_source="$source_dir/settings.json"

    if [ ! -d "$source_dir" ]; then
        log_error "Expected Pi config directory not found: $source_dir"
        return 1
    fi

    ensure_directory "$HOME/.pi"
    ensure_directory "$target_dir"

    if [ ! -f "$keybindings_source" ]; then
        log_error "Expected Pi keybindings not found: $keybindings_source"
        return 1
    fi

    if [ ! -d "$extensions_source" ]; then
        log_error "Expected Pi extensions directory not found: $extensions_source"
        return 1
    fi

    if [ ! -f "$settings_defaults" ]; then
        log_error "Expected Pi settings defaults not found: $settings_defaults"
        return 1
    fi

    if [ ! -f "$settings_seed" ]; then
        log_error "Expected Pi settings seed not found: $settings_seed"
        return 1
    fi

    if ! command_exists jq; then
        log_error "jq is required to merge portable Pi settings. Run task tools:setup and retry."
        return 1
    fi

    if ! jq -e 'type == "object"' "$settings_defaults" >/dev/null; then
        log_error "Pi settings defaults must contain a valid JSON object: $settings_defaults"
        return 1
    fi

    if ! jq -e 'type == "object"' "$settings_seed" >/dev/null; then
        log_error "Pi settings seed must contain a valid JSON object: $settings_seed"
        return 1
    fi

    install_pi_keybindings "$keybindings_source" "$keybindings_target"
    install_pi_extensions "$extensions_source" "$extensions_target"
    migrate_legacy_pi_settings_link "$legacy_settings_source" "$settings_seed" "$settings_target" || return 1
    initialize_local_pi_settings "$settings_seed" "$settings_target"
    merge_pi_settings_defaults "$settings_defaults" "$settings_target" || return 1
    remove_legacy_pi_readme_link "$source_dir/README.md" "$target_dir/README.md"

    log_info "Pi portable config installed."
    log_info "Kept local: settings model/provider/thinking/changelog, auth, models, sessions, trust, bin"
    log_info "Linked portable Pi keybindings and extensions from this repository."
    log_info "Create or keep ~/.pi/agent/auth.json separately (OAuth/API keys)."
}

install_pi_keybindings() {
    local source_path="$1"
    local target_path="$2"

    if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
        log_info "Already linked: $target_path"
        return 0
    fi

    if [ -L "$target_path" ]; then
        rm -f "$target_path"
    elif [ -e "$target_path" ]; then
        local backup_path
        backup_path="${target_path}.$(date +%Y%m%d_%H%M%S).pi-setup-backup"
        mv "$target_path" "$backup_path"
        log_warn "Backed up existing $target_path -> $backup_path"
    fi

    ln -s "$source_path" "$target_path"
    log_info "Linked $target_path -> $source_path"
}

install_pi_extensions() {
    local source_root="$1"
    local target_root="$2"
    local source_path
    local target_path
    local extension_name
    local backup_root

    backup_root="${target_root}.pi-setup-backups"
    ensure_directory "$target_root"

    for source_path in "$source_root"/*; do
        [ -d "$source_path" ] || continue
        extension_name="$(basename "$source_path")"
        target_path="$target_root/$extension_name"

        if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
            log_info "Already linked: $target_path"
            continue
        fi

        if [ -L "$target_path" ]; then
            rm -f "$target_path"
        elif [ -e "$target_path" ]; then
            local backup_path
            ensure_directory "$backup_root"
            backup_path="$backup_root/${extension_name}.$(date +%Y%m%d_%H%M%S)"
            mv "$target_path" "$backup_path"
            log_warn "Backed up existing $target_path -> $backup_path"
        fi

        ln -s "$source_path" "$target_path"
        log_info "Linked $target_path -> $source_path"
    done
}

migrate_legacy_pi_settings_link() {
    local legacy_source_path="$1"
    local seed_path="$2"
    local target_path="$3"

    if [ ! -L "$target_path" ]; then
        return 0
    fi

    local linked_path
    linked_path="$(readlink "$target_path")"
    if [ "$linked_path" != "$legacy_source_path" ]; then
        log_error "Refusing to replace unrelated Pi settings symlink: $target_path -> $linked_path"
        return 1
    fi

    if [ -f "$target_path" ]; then
        local preserved_path
        preserved_path="$(mktemp "${target_path}.migration.XXXXXX")"
        cp "$target_path" "$preserved_path"
        rm -f "$target_path"
        mv "$preserved_path" "$target_path"
        log_info "Converted tracked Pi settings symlink to a machine-local file."
        return 0
    fi

    rm -f "$target_path"
    cp "$seed_path" "$target_path"
    log_warn "Recovered dangling legacy Pi settings symlink into a machine-local settings file."
}

initialize_local_pi_settings() {
    local seed_path="$1"
    local target_path="$2"

    if [ ! -e "$target_path" ]; then
        cp "$seed_path" "$target_path"
        log_info "Initialized machine-local Pi settings from portable seed."
    fi
}

merge_pi_settings_defaults() {
    local defaults_path="$1"
    local target_path="$2"

    if [ ! -f "$target_path" ] || ! jq -e 'type == "object"' "$target_path" >/dev/null; then
        log_error "Refusing to overwrite invalid local Pi settings: $target_path"
        return 1
    fi

    local merged_path
    merged_path="$(mktemp "${target_path}.merged.XXXXXX")"
    if ! jq -s '.[0] * .[1]' "$target_path" "$defaults_path" > "$merged_path"; then
        rm -f "$merged_path"
        log_error "Failed to merge portable Pi settings into $target_path"
        return 1
    fi

    if cmp -s "$target_path" "$merged_path"; then
        rm -f "$merged_path"
        log_info "Portable Pi settings already applied: $target_path"
        return 0
    fi

    mv "$merged_path" "$target_path"
    log_info "Merged portable defaults into machine-local $target_path"
}

remove_legacy_pi_readme_link() {
    local legacy_source_path="$1"
    local target_path="$2"

    if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$legacy_source_path" ]; then
        rm -f "$target_path"
        log_info "Removed obsolete Pi config README symlink: $target_path"
    fi
}

if [ "$#" -eq 0 ]; then
    log_error "Usage: $0 setup_pi_config"
    exit 1
fi

"$@"
