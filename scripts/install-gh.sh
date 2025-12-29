#!/bin/bash

# Use sudo only if not root and sudo is available
SUDO=""
if [ "$EUID" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi

(type -p wget >/dev/null || ($SUDO apt update && $SUDO apt install wget -y)) \
	&& $SUDO mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& $SUDO mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list > /dev/null

$SUDO apt update
$SUDO apt install gh -y
