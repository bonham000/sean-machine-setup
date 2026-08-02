#!/bin/zsh -f

emulate -L zsh
setopt no_aliases pipe_fail

typeset repo_root=${0:A:h:h}
typeset fixture output
typeset -i exit_status

fixture=$(mktemp -d "${TMPDIR:-/tmp}/repo-menu-test.XXXXXX") || exit 1
trap 'rm -rf -- "$fixture"' EXIT

cat > "$fixture/targets.json" <<'JSON'
{
  "targets": {
    "internal-app": {
      "path": "../internal-app",
      "tier": "internal"
    },
    "client-app": {
      "path": "../client-app",
      "tier": "client"
    }
  },
  "auxiliary": {
    "machine-setup": {
      "path": "../machine-setup"
    }
  }
}
JSON

output=$(CORE_REPO="$fixture" "$repo_root/repo-menu.zsh" </dev/null 2>&1)
exit_status=$?

if (( exit_status != 1 )) || [[ $output != *'repo menu requires an interactive terminal.'* ]]; then
  print -u2 -- 'Repo menu failed to accept internal, client, and auxiliary registries.'
  print -u2 -- "$output"
  exit 1
fi

print -- 'Repo menu classification test passed.'
