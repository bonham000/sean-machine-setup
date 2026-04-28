#!/usr/bin/env python3
"""
Interactive repo navigation menu with arrow key navigation.
Prints selected repo path to stdout (UI goes to stderr)
so a shell function can cd into it.
"""

import sys
import subprocess
import termios
import tty
import os
from typing import List, Tuple

REPOS_DIR = os.path.expanduser("~/Documents")

# Keep this list in sync with REPOS in sync-repos.sh and pull-repos.sh
REPOS: List[Tuple[str, str]] = [
    ("sl-content-hub", "SL Content Hub"),
    ("language-hubs", "Language hubs"),
    ("second-language-monorepo", "Second Language monorepo"),
    ("stories-monorepo", "Stories monorepo"),
    ("priori-tools-monorepo", "Priori Tools monorepo"),
    ("daybreak-monorepo", "Daybreak monorepo"),
    ("core-repo", "Core repo"),
    ("abacus-monorepo", "Abacus monorepo"),
    ("super-claude", "Super Claude (CC memory)"),
]


class RepoMenu:
    def __init__(self):
        self.repos = REPOS
        self.selected_index = 0
        self.terminal_height, self.terminal_width = self._get_terminal_size()

    def _get_terminal_size(self) -> Tuple[int, int]:
        try:
            rows, cols = os.popen('stty size', 'r').read().split()
            return int(rows), int(cols)
        except Exception:
            return 24, 80

    def _eprint(self, *args, **kwargs):
        """Print to stderr so stdout stays clean for the path."""
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
        max_name_length = max(len(r[0]) for r in self.repos)
        name_width = max_name_length + 2
        desc_width = available_width - name_width - 7

        border_width = available_width
        top_border = "\u256d" + "\u2500" * (border_width - 2) + "\u256e"
        mid_border = "\u251c" + "\u2500" * (border_width - 2) + "\u2524"
        bottom_border = "\u2570" + "\u2500" * (border_width - 2) + "\u256f"

        self._eprint(f"\033[36m{top_border}\033[0m")
        header_text = "\U0001f4c2 Repos"
        padding = (border_width - len(header_text) - 2) // 2
        self._eprint(
            f"\033[36m\u2502\033[0m\033[1;33m{' ' * padding}{header_text}"
            f"{' ' * (border_width - len(header_text) - padding - 2)}\033[0m\033[36m\u2502\033[0m"
        )
        self._eprint(f"\033[36m{mid_border}\033[0m")

        for i, (name, desc) in enumerate(self.repos):
            display_name = name.ljust(name_width)
            display_desc = desc[:desc_width].ljust(desc_width)

            if i == self.selected_index:
                self._eprint(
                    f"\033[36m\u2502\033[0m \033[1;37;44m\u27a4 {display_name}\033[0m "
                    f"\033[36m\u2502\033[0m \033[1;37;44m{display_desc}\033[0m \033[36m\u2502\033[0m"
                )
            else:
                self._eprint(
                    f"\033[36m\u2502\033[0m  \033[32m{display_name}\033[0m "
                    f"\033[36m\u2502\033[0m \033[37m{display_desc}\033[0m \033[36m\u2502\033[0m"
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
        """Run menu. Returns selected repo path or None."""
        try:
            while True:
                self._draw_menu()
                key = self._get_key()

                total = len(self.repos)
                if key in ('\x1b[A', 'k'):
                    self.selected_index = (self.selected_index - 1) % total
                elif key in ('\x1b[B', 'j'):
                    self.selected_index = (self.selected_index + 1) % total
                elif key in ('\r', '\n'):
                    repo_dir = self.repos[self.selected_index][0]
                    return os.path.join(REPOS_DIR, repo_dir)
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

    menu = RepoMenu()
    result = menu.run()
    if result:
        print(result)


if __name__ == '__main__':
    main()
