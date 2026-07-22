#!/bin/zsh -f

emulate -L zsh
setopt no_aliases pipe_fail

typeset repo_root=${0:A:h:h}
typeset aliases_file="$repo_root/shell/aliases.sh"
typeset file line alias_name zsh_syntax_output
typeset -a failures bash_files zsh_files picker_files
typeset -A seen_aliases

if [[ ! -r $aliases_file ]]; then
  print -u2 -- 'shell/aliases.sh is missing.'
  exit 1
fi

for file in \
  "$repo_root/bash/aliases.sh" \
  "$repo_root/setup.sh" \
  "$repo_root/config/ghostty/zsh/.zshrc" \
  "$repo_root/shell/init.sh" \
  "$repo_root/shell/functions.sh" \
  "$repo_root/scripts"/*.sh; do
  if command rg -q '^[[:space:]]*alias[[:space:]]+[A-Za-z0-9_.-]+=' "$file"; then
    failures+=("shortcut alias defined outside shell/aliases.sh: ${file#$repo_root/}")
  fi
done

while IFS= read -r line; do
  if [[ $line =~ '^[[:space:]]*alias[[:space:]]+([A-Za-z0-9_.-]+)=' ]]; then
    alias_name=${match[1]}
    if [[ -n ${seen_aliases[$alias_name]:-} ]]; then
      failures+=("duplicate alias in shell/aliases.sh: $alias_name")
    else
      seen_aliases[$alias_name]=1
    fi
  fi
done < "$aliases_file"

bash_files=(
  "$repo_root/setup.sh"
  "$repo_root/bash/aliases.sh"
  "$repo_root/shell"/*.sh
  "$repo_root/scripts"/*.sh
)
for file in "${bash_files[@]}"; do
  if ! command bash -n "$file"; then
    failures+=("bash syntax check failed: ${file#$repo_root/}")
  fi
done

zsh_files=(
  "$repo_root/config/ghostty/zsh/.zshrc"
  "$repo_root/shell"/*.sh
  "$repo_root"/*.zsh
  "$repo_root/scripts"/*.zsh(N)
)
for file in "${zsh_files[@]}"; do
  zsh_syntax_output=$(command zsh -n "$file" 2>&1)
  if (( $? != 0 )); then
    print -u2 -- "$zsh_syntax_output"
    failures+=("zsh syntax check failed: ${file#$repo_root/}")
  fi
done

picker_files=(
  "$repo_root/commit-menu.zsh"
  "$repo_root/dev-task-menu.zsh"
  "$repo_root/package-menu.zsh"
  "$repo_root/repo-menu.zsh"
  "$repo_root/task-menu.zsh"
  "$repo_root/tmux-menu.zsh"
)
for file in "${picker_files[@]}"; do
  if [[ ! -x $file ]]; then
    failures+=("interactive tool is not executable: ${file#$repo_root/}")
  fi
done

if ! command rg -q '^\. "\$SEAN_MACHINE_SETUP_ROOT/shell/aliases\.sh"$' \
  "$repo_root/shell/init.sh"; then
  failures+=('shell/init.sh does not source shell/aliases.sh')
fi
if ! command rg -q '^\. "\$SEAN_MACHINE_SETUP_ROOT/shell/functions\.sh"$' \
  "$repo_root/shell/init.sh"; then
  failures+=('shell/init.sh does not source shell/functions.sh')
fi

if (( ${#failures} > 0 )); then
  print -u2 -- 'Shell shortcut validation failed:'
  for line in "${failures[@]}"; do
    print -u2 -- "  - $line"
  done
  exit 1
fi

print -- "Shell shortcuts valid: ${#seen_aliases} aliases, one tracked source tree."
