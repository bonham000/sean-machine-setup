#!/bin/bash
set -euo pipefail

CORE_REPO="${CORE_REPO:-$HOME/Documents/core-repo}"
exec task -d "$CORE_REPO" repos:pull "$@"
