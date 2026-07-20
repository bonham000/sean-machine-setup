#!/bin/zsh -f

# Fast repo-family picker for cj. The menu is written to stderr so the
# selected path can be captured from stdout by the calling shell function.

emulate -L zsh
setopt no_aliases

core_repo="${CORE_REPO:-$HOME/Documents/core-repo}"
targets_file="$core_repo/targets.json"

if [[ ! -r "$targets_file" ]]; then
  print -u2 -- "Repo targets not found: $targets_file"
  exit 1
fi

typeset -a repo_paths repo_labels target_lines
typeset relative_path repo_path line key second third
typeset -i selected=1

repo_paths=("${core_repo:A}")
repo_labels=("core-repo")
target_lines=("${(@f)$(<"$targets_file")}")

for line in "${target_lines[@]}"; do
  if [[ $line == '      "path": "'* ]]; then
    relative_path=${line#*\"path\": \"}
    relative_path=${relative_path%%\",*}
    repo_path="${core_repo:A}/$relative_path"
    repo_path="${repo_path:A}"
    repo_paths+=("$repo_path")
    repo_labels+=("${repo_path:t}")
  fi
done

if [[ ! -t 0 ]]; then
  print -u2 -- 'repo menu requires an interactive terminal.'
  exit 1
fi

render_menu() {
  printf '\033[H\033[J\033[?25l\033[1;36mRepos\033[0m\n\n' >&2

  typeset -i index
  for (( index = 1; index <= ${#repo_paths}; index += 1 )); do
    if (( index == selected )); then
      printf '\033[36m> %s\033[0m\n' "${repo_labels[$index]}" >&2
    else
      printf '  %s\n' "${repo_labels[$index]}" >&2
    fi
  done

  printf '\nup/down or j/k: navigate   enter: select   q: quit\n' >&2
}

cleanup() {
  printf '\033[?25h\033[H\033[J' >&2
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

render_menu

while IFS= read -rsk1 key; do
  if [[ $key == $'\e' ]]; then
    if IFS= read -rsk1 -t 0.03 second && [[ $second == '[' ]] &&
      IFS= read -rsk1 -t 0.03 third; then
      key="$key$second$third"
    else
      exit 0
    fi
  fi

  case "$key" in
    $'\e[A' | k)
      (( selected = selected == 1 ? ${#repo_paths} : selected - 1 ))
      render_menu
      ;;
    $'\e[B' | j)
      (( selected = selected == ${#repo_paths} ? 1 : selected + 1 ))
      render_menu
      ;;
    $'\r' | $'\n')
      print -r -- "${repo_paths[$selected]}"
      exit 0
      ;;
    q)
      exit 0
      ;;
  esac
done
