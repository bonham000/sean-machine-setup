# Single source entry point for interactive shell shortcuts.
# Source this file; do not execute it.

if [ -z "${SEAN_MACHINE_SETUP_ROOT:-}" ]; then
    _sean_shortcut_entry="$(readlink "$HOME/.bash_aliases" 2>/dev/null || true)"
    case "$_sean_shortcut_entry" in
        */shell/init.sh)
            SEAN_MACHINE_SETUP_ROOT="${_sean_shortcut_entry%/shell/init.sh}"
            ;;
        *)
            SEAN_MACHINE_SETUP_ROOT="$HOME/Documents/sean-machine-setup"
            ;;
    esac
    unset _sean_shortcut_entry
fi

if [ ! -r "$SEAN_MACHINE_SETUP_ROOT/shell/aliases.sh" ] ||
    [ ! -r "$SEAN_MACHINE_SETUP_ROOT/shell/functions.sh" ]; then
    printf '%s\n' "Machine setup shortcuts not found under $SEAN_MACHINE_SETUP_ROOT" >&2
    return 1
fi

. "$SEAN_MACHINE_SETUP_ROOT/shell/aliases.sh"
. "$SEAN_MACHINE_SETUP_ROOT/shell/functions.sh"
