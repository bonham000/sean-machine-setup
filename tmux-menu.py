#!/usr/bin/env python3
"""
Interactive tmux session picker with arrow key navigation.
Lets you pick from `tmux ls` output and attaches to the selected session.
"""

import sys
import subprocess
import termios
import tty
import os
from typing import List, Tuple, Optional


class TmuxSessionMenu:
    def __init__(self):
        self.sessions: List[Tuple[str, str]] = []  # (name, details)
        self.selected_index = 0
        self.terminal_height, self.terminal_width = self._get_terminal_size()
        self.max_display_items = min(30, self.terminal_height - 8)
        self.scroll_offset = 0
        self.error_message: Optional[str] = None

    def _get_terminal_size(self) -> Tuple[int, int]:
        """Get terminal size, fallback to 24x80 if unable to determine."""
        try:
            rows, cols = os.popen('stty size', 'r').read().split()
            return int(rows), int(cols)
        except Exception:
            return 24, 80

    def _get_sessions(self) -> List[Tuple[str, str]]:
        """Return list of tmux sessions (name, details)."""
        try:
            result = subprocess.run(
                ['tmux', 'ls'],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except FileNotFoundError:
            self.error_message = "tmux not found on PATH."
            return []
        except subprocess.TimeoutExpired:
            self.error_message = "tmux ls timed out."
            return []

        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            if "no server running" in stderr.lower():
                self.error_message = "No tmux server running. Start a session first."
            else:
                self.error_message = stderr or "Failed to query tmux sessions."
            return []

        sessions: List[Tuple[str, str]] = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            if ':' in line:
                name, rest = line.split(':', 1)
                sessions.append((name.strip(), rest.strip()))
            else:
                sessions.append((line, ''))

        if not sessions and not self.error_message:
            self.error_message = "tmux returned no sessions."

        return sessions

    def _clear_screen(self):
        """Clear the screen."""
        print('\033[2J\033[H', end='', flush=True)

    def _hide_cursor(self):
        """Hide the cursor."""
        print('\033[?25l', end='', flush=True)

    def _show_cursor(self):
        """Show the cursor."""
        print('\033[?25h', end='', flush=True)

    def _get_display_range(self) -> Tuple[int, int]:
        """Get the range of items to display based on scroll offset."""
        start = self.scroll_offset
        end = min(start + self.max_display_items, len(self.sessions))
        return start, end

    def _update_scroll(self):
        """Update scroll offset based on selected index."""
        if self.selected_index < self.scroll_offset:
            self.scroll_offset = self.selected_index
        elif self.selected_index >= self.scroll_offset + self.max_display_items:
            self.scroll_offset = self.selected_index - self.max_display_items + 1

    def _draw_menu(self):
        """Render the menu UI."""
        self._clear_screen()
        self._hide_cursor()

        available_width = max(80, self.terminal_width - 4)
        max_name_length = max((len(name) for name, _ in self.sessions), default=20)
        name_width = min(max_name_length + 2, available_width // 3)
        detail_width = available_width - name_width - 7

        border_width = available_width
        top_border = "╭" + "─" * (border_width - 2) + "╮"
        mid_border = "├" + "─" * (border_width - 2) + "┤"
        bottom_border = "╰" + "─" * (border_width - 2) + "╯"

        print(f"\033[36m{top_border}\033[0m")
        header_text = "🪟 tmux Sessions"
        padding = (border_width - len(header_text) - 2) // 2
        print(f"\033[36m│\033[0m\033[1;33m{' ' * padding}{header_text}{' ' * (border_width - len(header_text) - padding - 2)}\033[0m\033[36m│\033[0m")
        print(f"\033[36m{mid_border}\033[0m")

        if not self.sessions:
            message = self.error_message or "No tmux sessions found."
            msg_padding = (border_width - len(message) - 2) // 2
            print(f"\033[36m│\033[0m\033[31m{' ' * msg_padding}{message}{' ' * (border_width - len(message) - msg_padding - 2)}\033[0m\033[36m│\033[0m")
            print(f"\033[36m{bottom_border}\033[0m")
            return

        start, end = self._get_display_range()
        for idx in range(start, end):
            name, details = self.sessions[idx]
            display_name = name.ljust(name_width)

            if details:
                display_details = details[:detail_width - 3] + "..." if len(details) > detail_width else details.ljust(detail_width)
            else:
                display_details = "".ljust(detail_width)

            if idx == self.selected_index:
                print(f"\033[36m│\033[0m \033[1;37;44m➤ {display_name}\033[0m \033[36m│\033[0m \033[1;37;44m{display_details}\033[0m \033[36m│\033[0m")
            else:
                print(f"\033[36m│\033[0m  \033[32m{display_name}\033[0m \033[36m│\033[0m \033[37m{display_details}\033[0m \033[36m│\033[0m")

        total = len(self.sessions)
        if total > self.max_display_items:
            print(f"\033[36m{mid_border}\033[0m")
            showing = f"Showing {start + 1}-{end} of {total} sessions"
            pad = border_width - len(showing) - 2
            print(f"\033[36m│\033[0m \033[33m{showing}\033[0m{' ' * pad}\033[36m│\033[0m")

        print(f"\033[36m{mid_border}\033[0m")
        controls = "↑↓/j k: Navigate  Enter: Attach  q/Esc/Ctrl+C: Quit"
        pad = border_width - len(controls) - 2
        print(f"\033[36m│\033[0m \033[35m{controls}\033[0m{' ' * pad}\033[36m│\033[0m")
        print(f"\033[36m{bottom_border}\033[0m")

        sys.stdout.flush()

    def _get_key(self) -> str:
        """Read single keypress."""
        try:
            fd = sys.stdin.fileno()
            old_settings = termios.tcgetattr(fd)
            try:
                tty.setraw(fd)
                key = sys.stdin.read(1)
                if key == '\x1b':
                    key += sys.stdin.read(2)
                return key
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        except (termios.error, OSError, EOFError):
            print("\n⚠️  Interactive mode not available. Run in a proper terminal.")
            sys.exit(1)

    def _attach_session(self, session_name: str):
        """Attach to the selected tmux session."""
        self._show_cursor()
        self._clear_screen()
        print(f"\033[1;36m🔗 Attaching to session: \033[1;32m{session_name}\033[0m\n")
        try:
            result = subprocess.run(['tmux', 'attach', '-t', session_name], check=False)
            if result.returncode != 0:
                print(f"\n\033[1;31m❌ Failed to attach (exit code {result.returncode}).\033[0m")
                print("\033[35mPress any key to return...\033[0m")
                self._get_key()
        except FileNotFoundError:
            print("\n\033[1;31m❌ tmux not found on PATH.\033[0m")
            print("\033[35mPress any key to return...\033[0m")
            self._get_key()

    def run(self):
        """Main menu loop."""
        self.sessions = self._get_sessions()
        if not self.sessions:
            message = self.error_message or "No tmux sessions found."
            print(f"❌ {message}")
            return

        try:
            while True:
                self._draw_menu()
                key = self._get_key()

                if key == '\x1b[A':  # Up arrow
                    if self.sessions:
                        if self.selected_index > 0:
                            self.selected_index -= 1
                        else:
                            self.selected_index = len(self.sessions) - 1
                        self._update_scroll()
                elif key == '\x1b[B':  # Down arrow
                    if self.sessions:
                        if self.selected_index < len(self.sessions) - 1:
                            self.selected_index += 1
                        else:
                            self.selected_index = 0
                        self._update_scroll()
                elif key in ('j',):  # Vim-down
                    if self.sessions:
                        if self.selected_index < len(self.sessions) - 1:
                            self.selected_index += 1
                        else:
                            self.selected_index = 0
                        self._update_scroll()
                elif key in ('k',):  # Vim-up
                    if self.sessions:
                        if self.selected_index > 0:
                            self.selected_index -= 1
                        else:
                            self.selected_index = len(self.sessions) - 1
                        self._update_scroll()
                elif key in ('\r', '\n'):
                    session_name = self.sessions[self.selected_index][0]
                    self._attach_session(session_name)
                    break
                elif key in ('q', '\x1b', '\x1b['):
                    break
                elif key == '\x03':  # Ctrl+C
                    break
        except KeyboardInterrupt:
            print("\n\033[33m⚠️  Menu interrupted by user\033[0m")
        finally:
            self._show_cursor()
            self._clear_screen()


def main():
    """Entrypoint."""
    if not sys.stdin.isatty():
        print("❌ This script requires an interactive terminal.")
        print("Run it directly in bash/zsh, not via piping or redirection.")
        sys.exit(1)

    menu = TmuxSessionMenu()
    menu.run()


if __name__ == '__main__':
    main()
