#!/usr/bin/env python3
"""
Fast package.json script menu with arrow key navigation.
Similar to task-menu-fast.py but for npm/bun scripts.
"""

import sys
import subprocess
import termios
import tty
import os
import json
from typing import List, Tuple, Optional


class PackageMenu:
    def __init__(self):
        self.scripts: List[Tuple[str, str]] = []  # (name, command)
        self.selected_index = 0
        self.terminal_height, self.terminal_width = self._get_terminal_size()
        self.max_display_items = min(30, self.terminal_height - 8)  # Show 30 items before scrolling
        self.scroll_offset = 0

    def _get_terminal_size(self) -> Tuple[int, int]:
        """Get terminal size, fallback to 24x80 if unable to determine."""
        try:
            rows, cols = os.popen('stty size', 'r').read().split()
            return int(rows), int(cols)
        except:
            return 24, 80

    def _get_scripts(self) -> List[Tuple[str, str]]:
        """Get all scripts from package.json."""
        try:
            # Look for package.json in current directory
            if not os.path.exists('package.json'):
                return []

            with open('package.json', 'r') as f:
                package_data = json.load(f)

            scripts = package_data.get('scripts', {})
            if not scripts:
                return []

            # Convert to list of tuples (name, command)
            return [(name, cmd) for name, cmd in sorted(scripts.items())]

        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            return []

    def _clear_screen(self):
        """Clear the screen."""
        print('\033[2J\033[H', end='', flush=True)

    def _move_cursor(self, row: int, col: int = 0):
        """Move cursor to specific position."""
        print(f'\033[{row};{col}H', end='', flush=True)

    def _hide_cursor(self):
        """Hide the cursor."""
        print('\033[?25l', end='', flush=True)

    def _show_cursor(self):
        """Show the cursor."""
        print('\033[?25h', end='', flush=True)

    def _get_display_range(self) -> Tuple[int, int]:
        """Get the range of items to display based on scroll offset."""
        start = self.scroll_offset
        end = min(start + self.max_display_items, len(self.scripts))
        return start, end

    def _update_scroll(self):
        """Update scroll offset based on selected index."""
        if self.selected_index < self.scroll_offset:
            self.scroll_offset = self.selected_index
        elif self.selected_index >= self.scroll_offset + self.max_display_items:
            self.scroll_offset = self.selected_index - self.max_display_items + 1

    def _draw_menu(self):
        """Draw the script menu with colors and improved layout."""
        self._clear_screen()
        self._hide_cursor()

        # Calculate dynamic widths based on terminal size
        available_width = max(80, self.terminal_width - 4)  # Leave room for borders

        # Find the longest script name to size the first column appropriately
        max_script_name_length = max(len(script[0]) for script in self.scripts) if self.scripts else 20
        name_width = min(max_script_name_length + 2, available_width // 3)  # At most 1/3 the width
        cmd_width = available_width - name_width - 7  # Rest for command, minus separators

        # Create borders
        border_width = available_width
        top_border = "╭" + "─" * (border_width - 2) + "╮"
        mid_border = "├" + "─" * (border_width - 2) + "┤"
        bottom_border = "╰" + "─" * (border_width - 2) + "╯"

        # Header with colors
        print(f"\033[36m{top_border}\033[0m")  # Cyan border
        header_text = "📦 Package Scripts"
        padding = (border_width - len(header_text) - 2) // 2
        print(f"\033[36m│\033[0m\033[1;33m{' ' * padding}{header_text}{' ' * (border_width - len(header_text) - padding - 2)}\033[0m\033[36m│\033[0m")  # Yellow header
        print(f"\033[36m{mid_border}\033[0m")

        if not self.scripts:
            error_msg = "No scripts found in package.json"
            padding = (border_width - len(error_msg) - 2) // 2
            print(f"\033[36m│\033[0m\033[31m{' ' * padding}{error_msg}{' ' * (border_width - len(error_msg) - padding - 2)}\033[0m\033[36m│\033[0m")  # Red error
            print(f"\033[36m{bottom_border}\033[0m")
            return

        start, end = self._get_display_range()

        # Script list with colors
        for i in range(start, end):
            name, cmd = self.scripts[i]

            # Display script name, pad to column width
            display_name = name.ljust(name_width)

            # Display command
            if len(cmd) > cmd_width:
                display_cmd = cmd[:cmd_width-3] + "..."
            else:
                display_cmd = cmd.ljust(cmd_width)

            # Color scheme for selected/unselected items
            if i == self.selected_index:
                # Selected item: bright colors with background
                print(f"\033[36m│\033[0m \033[1;37;44m➤ {display_name}\033[0m \033[36m│\033[0m \033[1;37;44m{display_cmd}\033[0m \033[36m│\033[0m")
            else:
                # Unselected items: muted colors
                print(f"\033[36m│\033[0m  \033[32m{display_name}\033[0m \033[36m│\033[0m \033[37m{display_cmd}\033[0m \033[36m│\033[0m")

        # Footer with scroll indicator and controls
        total_scripts = len(self.scripts)
        if total_scripts > self.max_display_items:
            showing_start = start + 1
            showing_end = end
            print(f"\033[36m{mid_border}\033[0m")
            scroll_info = f"Showing {showing_start}-{showing_end} of {total_scripts} scripts"
            padding = border_width - len(scroll_info) - 2
            print(f"\033[36m│\033[0m \033[33m{scroll_info}\033[0m{' ' * padding}\033[36m│\033[0m")

        print(f"\033[36m{mid_border}\033[0m")
        controls = "↑↓: Navigate  Enter: Select  q/Esc/Ctrl+C: Quit  j/k: Vim keys"
        padding = border_width - len(controls) - 2
        print(f"\033[36m│\033[0m \033[35m{controls}\033[0m{' ' * padding}\033[36m│\033[0m")  # Magenta controls
        print(f"\033[36m{bottom_border}\033[0m")

        sys.stdout.flush()

    def _get_key(self) -> str:
        """Get a single keypress from stdin."""
        try:
            fd = sys.stdin.fileno()
            old_settings = termios.tcgetattr(fd)
            try:
                tty.setraw(fd)
                key = sys.stdin.read(1)

                # Handle escape sequences (arrow keys)
                if key == '\x1b':
                    key += sys.stdin.read(2)

                return key
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        except (termios.error, OSError, EOFError):
            # Fallback for non-interactive terminals
            print("\n⚠️  Interactive mode not available in this terminal environment.")
            print("Please run this script in a proper interactive terminal (like bash/zsh).")
            sys.exit(1)

    def _run_script(self, script_name: str):
        """Run the selected script with bun."""
        self._show_cursor()
        self._clear_screen()

        print(f"\033[1;36m🚀 Running script: \033[1;32m{script_name}\033[0m\n")

        try:
            # Run the script in the foreground with bun
            result = subprocess.run(['bun', 'run', script_name], check=False)
            if result.returncode == 0:
                print(f"\n\033[1;32m✅ Script '{script_name}' completed successfully!\033[0m")
            else:
                print(f"\n\033[1;33m⚠️  Script '{script_name}' completed with exit code {result.returncode}\033[0m")
        except KeyboardInterrupt:
            print(f"\n\n\033[1;33m⚠️  Script '{script_name}' interrupted by user\033[0m")
        except Exception as e:
            print(f"\n\n\033[1;31m❌ Error running script: {e}\033[0m")

        print(f"\n\033[35mPress any key to exit...\033[0m")
        try:
            self._get_key()
        except:
            pass

    def run(self):
        """Run the interactive package script menu."""
        # Load scripts
        self.scripts = self._get_scripts()

        if not self.scripts:
            print("❌ No scripts found. Make sure you're in a directory with a package.json containing scripts.")
            return

        try:
            while True:
                self._draw_menu()
                key = self._get_key()

                if key == '\x1b[A':  # Up arrow
                    if self.scripts:
                        if self.selected_index > 0:
                            self.selected_index -= 1
                        else:
                            self.selected_index = len(self.scripts) - 1
                        self._update_scroll()
                elif key == '\x1b[B':  # Down arrow
                    if self.scripts:
                        if self.selected_index < len(self.scripts) - 1:
                            self.selected_index += 1
                        else:
                            self.selected_index = 0
                        self._update_scroll()
                elif key == '\r' or key == '\n':  # Enter
                    script_name = self.scripts[self.selected_index][0]
                    self._run_script(script_name)
                    break
                elif key == 'q':  # q to quit
                    break
                elif key == '\x1b' or key == '\x1b[':  # Escape (handle both forms)
                    break
                elif key == '\x03':  # Ctrl+C
                    break
                elif key == 'j':  # Vim-style down
                    if self.scripts:
                        if self.selected_index < len(self.scripts) - 1:
                            self.selected_index += 1
                        else:
                            self.selected_index = 0
                        self._update_scroll()
                elif key == 'k':  # Vim-style up
                    if self.scripts:
                        if self.selected_index > 0:
                            self.selected_index -= 1
                        else:
                            self.selected_index = len(self.scripts) - 1
                        self._update_scroll()

        except KeyboardInterrupt:
            # Handle Ctrl+C gracefully
            print(f"\n\033[33m⚠️  Menu interrupted by user\033[0m")
        finally:
            self._show_cursor()
            self._clear_screen()


def main():
    """Main entry point."""
    # Check if we're in an interactive terminal
    if not sys.stdin.isatty():
        print("❌ This script requires an interactive terminal.")
        print("Please run it directly in bash/zsh, not through pipes or redirects.")
        sys.exit(1)

    menu = PackageMenu()
    menu.run()


if __name__ == '__main__':
    main()
