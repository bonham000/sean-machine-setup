#!/usr/bin/env python3
"""Compatibility wrapper for the native repo-family picker."""

import os
import subprocess
import sys


def main() -> int:
    setup_dir = os.path.dirname(os.path.abspath(__file__))
    return subprocess.call(
        [os.path.join(setup_dir, "repo-menu.zsh"), *sys.argv[1:]],
    )


if __name__ == "__main__":
    raise SystemExit(main())
