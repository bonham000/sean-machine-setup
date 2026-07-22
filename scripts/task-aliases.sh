#!/bin/bash

# Compatibility entry point. Shortcut installation is centralized in
# scripts/shell-config.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/shell-config.sh" install_shortcuts
