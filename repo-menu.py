#!/usr/bin/env python3
"""Compatibility wrapper for the core-repo repo-family picker."""

import os
import subprocess
import sys


def main() -> int:
    core_repo = os.environ.get(
        "CORE_REPO",
        os.path.expanduser("~/Documents/core-repo"),
    )
    return subprocess.call(["task", "-d", core_repo, "repos:menu", *sys.argv[1:]])


if __name__ == "__main__":
    raise SystemExit(main())
