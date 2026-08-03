#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_HOME="$(mktemp -d)"

cleanup() {
    rm -rf "$TEST_HOME"
}
trap cleanup EXIT

mkdir -p "$TEST_HOME/.pi/agent"
cat > "$TEST_HOME/.pi/agent/settings.json" <<'JSON'
{
  "lastChangelogVersion": "local-version",
  "defaultProvider": "local-provider",
  "defaultModel": "local-model",
  "defaultThinkingLevel": "high",
  "theme": "light"
}
JSON
mkdir -p "$TEST_HOME/.pi/agent/extensions/pretty-footer"
printf 'local extension\n' > "$TEST_HOME/.pi/agent/extensions/pretty-footer/marker"

HOME="$TEST_HOME" bash "$SCRIPT_DIR/setup-pi-config.sh" setup_pi_config >/dev/null

settings="$TEST_HOME/.pi/agent/settings.json"
keybindings="$TEST_HOME/.pi/agent/keybindings.json"
pretty_footer="$TEST_HOME/.pi/agent/extensions/pretty-footer"
prompt_border="$TEST_HOME/.pi/agent/extensions/prompt-border"

test -f "$settings"
test ! -L "$settings"
test -L "$keybindings"
test "$(readlink "$keybindings")" = "$REPO_ROOT/config/pi/agent/keybindings.json"
test -L "$pretty_footer"
test "$(readlink "$pretty_footer")" = "$REPO_ROOT/config/pi/agent/extensions/pretty-footer"
test -L "$prompt_border"
test "$(readlink "$prompt_border")" = "$REPO_ROOT/config/pi/agent/extensions/prompt-border"
backup_marker="$(find "$TEST_HOME/.pi/agent/extensions.pi-setup-backups" -path '*/pretty-footer.*/marker' -print -quit)"
test -n "$backup_marker"
test "$(cat "$backup_marker")" = "local extension"
jq -e '
  .lastChangelogVersion == "local-version" and
  .defaultProvider == "local-provider" and
  .defaultModel == "local-model" and
  .defaultThinkingLevel == "high" and
  .theme == "dark" and
  .packages == ["npm:pi-calm@1.0.1"]
' "$settings" >/dev/null

first_checksum="$(shasum -a 256 "$settings")"
HOME="$TEST_HOME" bash "$SCRIPT_DIR/setup-pi-config.sh" setup_pi_config >/dev/null
test "$(shasum -a 256 "$settings")" = "$first_checksum"

rm -f "$settings"
ln -s "$REPO_ROOT/config/pi/agent/settings.json" "$settings"
HOME="$TEST_HOME" bash "$SCRIPT_DIR/setup-pi-config.sh" setup_pi_config >/dev/null
test -f "$settings"
test ! -L "$settings"
jq -e '.theme == "dark" and .packages == ["npm:pi-calm@1.0.1"]' "$settings" >/dev/null
jq -e '
  .defaultProvider == "openai-codex" and
  .defaultModel == "gpt-5.6-sol" and
  .defaultThinkingLevel == "medium"
' "$settings" >/dev/null

echo "Pi config setup tests passed."
