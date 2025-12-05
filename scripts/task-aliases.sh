#!/bin/bash

# Add task menu aliases to shell configuration files

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_DIR="$(dirname "$SCRIPT_DIR")"

add_aliases() {
    local shell_rc="$1"

    if [ -f "$shell_rc" ]; then
        # Check if aliases already exist
        if ! grep -q "alias tm=" "$shell_rc"; then
            echo "" >> "$shell_rc"
            echo "# Task and package menu aliases" >> "$shell_rc"
            echo "alias tm='$SETUP_DIR/task-menu-fast.py'  # Fast task menu with Python" >> "$shell_rc"
            echo "alias rn='$SETUP_DIR/package-menu.py'  # Fast package.json script menu" >> "$shell_rc"
            echo "alias tmx='$SETUP_DIR/tmux-menu.py'  # Tmux session picker" >> "$shell_rc"
            echo "Aliases added to $shell_rc"
        else
            echo "Aliases already exist in $shell_rc"
            # Update the paths in case they've changed (use @ as delimiter to avoid path conflicts)
            sed -i '' "s@alias tm=.*@alias tm='$SETUP_DIR/task-menu-fast.py'  # Fast task menu with Python@" "$shell_rc"
            # Add rn alias if it doesn't exist
            if ! grep -q "alias rn=" "$shell_rc"; then
                sed -i '' "/alias tm=/a\\
alias rn='$SETUP_DIR/package-menu.py'  # Fast package.json script menu
" "$shell_rc"
            else
                sed -i '' "s@alias rn=.*@alias rn='$SETUP_DIR/package-menu.py'  # Fast package.json script menu@" "$shell_rc"
            fi
            # Add tmx alias if it doesn't exist
            if ! grep -q "alias tmx=" "$shell_rc"; then
                if grep -q "alias rn=" "$shell_rc"; then
                    sed -i '' "/alias rn=/a\\
alias tmx='$SETUP_DIR/tmux-menu.py'  # Tmux session picker
" "$shell_rc"
                else
                    sed -i '' "/alias tm=/a\\
alias tmx='$SETUP_DIR/tmux-menu.py'  # Tmux session picker
" "$shell_rc"
                fi
            else
                sed -i '' "s@alias tmx=.*@alias tmx='$SETUP_DIR/tmux-menu.py'  # Tmux session picker@" "$shell_rc"
            fi
            echo "Aliases updated in $shell_rc"
        fi
    fi
}

# Add to bash
add_aliases "$HOME/.bashrc"

# Add to zsh
add_aliases "$HOME/.zshrc"

echo ""
echo "✅ Task and package menu aliases installed!"
echo ""
echo "Usage:"
echo "  tm   - Open fast task menu with Python"
echo "  rn  - Open package.json script menu"
echo "  tmx  - Open tmux session picker"
echo ""
echo "Or use the task command:"
echo "  task menu      - Open interactive task menu"
echo ""
echo "📝 Note: The aliases will be available in new shell sessions."
echo "   To use them now, either:"
echo "   • Switch to zsh: zsh"
echo "   • Or reload bash: source ~/.bashrc"
echo ""
echo "⚠️  Important: .zshrc only works in zsh, .bashrc only works in bash!"
echo "   Don't run 'source ~/.zshrc' from bash - it will cause errors."

# Create symlinks for immediate use
echo ""
echo "Creating symlinks for immediate use..."
# Create symlinks in a directory that's likely in PATH
if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    ln -sf "$SETUP_DIR/task-menu-fast.py" /usr/local/bin/tm 2>/dev/null
    ln -sf "$SETUP_DIR/package-menu.py" /usr/local/bin/rn 2>/dev/null
    ln -sf "$SETUP_DIR/tmux-menu.py" /usr/local/bin/tmx 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "✅ Symlinks created in /usr/local/bin - commands available immediately!"
        echo "   You can now use 'tm', 'rn', and 'tmx' commands directly!"
    else
        echo "ℹ️  Could not create symlinks (may already exist or need permissions)"
    fi
else
    echo "⚠️  /usr/local/bin not writable, skipping symlink creation"
    echo "   The aliases will work after reloading your shell"
fi
