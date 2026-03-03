#!/usr/bin/env python3
"""
Interactive commit message menu with arrow key navigation.
Runs git add . && git commit -m <selected message>.
"""

import sys
import subprocess
import termios
import tty
import os
from typing import List, Tuple

MESSAGES: List[Tuple[str, str]] = [
    ("Code linting and formatting", "style"),
    ("Documentation updates", "docs"),
    ("Quick fix", "fix"),
    ("Grabbag of a lot of changes", "misc"),
]


class CommitMenu:
    def __init__(self):
        self.messages = MESSAGES
        self.selected_index = 0
        self.terminal_height, self.terminal_width = self._get_terminal_size()

    def _get_terminal_size(self) -> Tuple[int, int]:
        try:
            rows, cols = os.popen('stty size', 'r').read().split()
            return int(rows), int(cols)
        except Exception:
            return 24, 80

    def _eprint(self, *args, **kwargs):
        print(*args, file=sys.stderr, **kwargs)

    def _hide_cursor(self):
        sys.stderr.write('\033[?25l')
        sys.stderr.flush()

    def _show_cursor(self):
        sys.stderr.write('\033[?25h')
        sys.stderr.flush()

    def _clear_screen(self):
        sys.stderr.write('\033[2J\033[H')
        sys.stderr.flush()

    def _draw_menu(self):
        self._clear_screen()
        self._hide_cursor()

        available_width = max(60, self.terminal_width - 4)
        max_msg_length = max(len(m[0]) for m in self.messages)
        msg_width = max_msg_length + 2
        tag_width = available_width - msg_width - 7

        border_width = available_width
        top_border = "\u256d" + "\u2500" * (border_width - 2) + "\u256e"
        mid_border = "\u251c" + "\u2500" * (border_width - 2) + "\u2524"
        bottom_border = "\u2570" + "\u2500" * (border_width - 2) + "\u256f"

        self._eprint(f"\033[36m{top_border}\033[0m")
        header_text = "\U0001f4dd Quick Commit"
        padding = (border_width - len(header_text) - 2) // 2
        self._eprint(
            f"\033[36m\u2502\033[0m\033[1;33m{' ' * padding}{header_text}"
            f"{' ' * (border_width - len(header_text) - padding - 2)}\033[0m\033[36m\u2502\033[0m"
        )
        self._eprint(f"\033[36m{mid_border}\033[0m")

        for i, (msg, tag) in enumerate(self.messages):
            display_msg = msg.ljust(msg_width)
            display_tag = f"[{tag}]"[:tag_width].ljust(tag_width)

            if i == self.selected_index:
                self._eprint(
                    f"\033[36m\u2502\033[0m \033[1;37;44m\u27a4 {display_msg}\033[0m "
                    f"\033[36m\u2502\033[0m \033[1;37;44m{display_tag}\033[0m \033[36m\u2502\033[0m"
                )
            else:
                self._eprint(
                    f"\033[36m\u2502\033[0m  \033[32m{display_msg}\033[0m "
                    f"\033[36m\u2502\033[0m \033[37m{display_tag}\033[0m \033[36m\u2502\033[0m"
                )

        self._eprint(f"\033[36m{mid_border}\033[0m")
        controls = "\u2191\u2193/j k: Navigate  Enter: Select  q/Esc: Quit"
        pad = border_width - len(controls) - 2
        self._eprint(
            f"\033[36m\u2502\033[0m \033[35m{controls}\033[0m{' ' * pad}\033[36m\u2502\033[0m"
        )
        self._eprint(f"\033[36m{bottom_border}\033[0m")

        sys.stderr.flush()

    def _get_key(self) -> str:
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
            self._eprint("\n\u26a0\ufe0f  Interactive mode not available. Run in a proper terminal.")
            sys.exit(1)

    def run(self) -> str | None:
        """Run menu. Returns selected commit message or None."""
        try:
            while True:
                self._draw_menu()
                key = self._get_key()

                total = len(self.messages)
                if key in ('\x1b[A', 'k'):
                    self.selected_index = (self.selected_index - 1) % total
                elif key in ('\x1b[B', 'j'):
                    self.selected_index = (self.selected_index + 1) % total
                elif key in ('\r', '\n'):
                    return self.messages[self.selected_index][0]
                elif key in ('q', '\x1b', '\x1b[', '\x03'):
                    return None
        except KeyboardInterrupt:
            return None
        finally:
            self._show_cursor()
            self._clear_screen()


def main():
    if not sys.stdin.isatty():
        print("\u274c This script requires an interactive terminal.", file=sys.stderr)
        sys.exit(1)

    menu = CommitMenu()
    message = menu.run()
    if message:
        print(f"\033[36mRunning:\033[0m git add . && git commit -m \"{message}\"", file=sys.stderr)
        result = subprocess.run(["git", "add", "."])
        if result.returncode != 0:
            print("\033[31mError:\033[0m git add failed.", file=sys.stderr)
            sys.exit(1)
        result = subprocess.run(["git", "commit", "-m", message])
        sys.exit(result.returncode)


if __name__ == '__main__':
    main()
