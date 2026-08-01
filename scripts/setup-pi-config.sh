#!/bin/bash

# Setup portable Pi configuration from the repository.
# This links tracked files from config/pi/agent into ~/.pi/agent,
# while leaving machine-local state files in place.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils.sh"

setup_pi_config() {
    local repo_root
    local source_dir
    local target_dir
    local source_path target_path

    repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
    source_dir="$repo_root/config/pi/agent"
    target_dir="$HOME/.pi/agent"

    if [ ! -d "$source_dir" ]; then
        log_error "Expected Pi config directory not found: $source_dir"
        return 1
    fi

    ensure_directory "$HOME/.pi"
    ensure_directory "$target_dir"

    if [ -z "$(ls -A "$source_dir")" ]; then
        log_warn "No tracked Pi config files in $source_dir"
        return 0
    fi

    while IFS= read -r -d '' source_path; do
        local source_name
        source_name="$(basename "$source_path")"

        # Keep these files machine-local/sensitive per-host and do not sync.
        case "$source_name" in
            auth.json|models-store.json|models.json|sessions|trust.json|bin)
                continue
                ;;
        esac

        target_path="$target_dir/$source_name"

        if [ -L "$target_path" ] || [ -e "$target_path" ]; then
            if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
                log_info "Already linked: $target_path"
                continue
            fi

            if [ -L "$target_path" ]; then
                rm -f "$target_path"
            else
                local backup_path
                backup_path="${target_path}.$(date +%Y%m%d_%H%M%S).pi-setup-backup"
                mv "$target_path" "$backup_path"
                log_warn "Backed up existing $target_path -> $backup_path"
            fi
        fi

        ln -s "$source_path" "$target_path"
        log_info "Linked $target_path -> $source_path"
    done < <(find "$source_dir" -mindepth 1 -maxdepth 1 -print0)

    log_info "Pi portable config installed."
    log_info "Skipped machine-local files: auth.json, models.json, models-store.json, sessions, trust.json, bin"
    log_info "Create or keep ~/.pi/agent/auth.json separately (OAuth/API keys)."
}

if [ "$#" -eq 0 ]; then
    log_error "Usage: $0 setup_pi_config"
    exit 1
fi

"$@"
