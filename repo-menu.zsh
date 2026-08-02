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

typeset -a repo_paths repo_labels repo_tiers target_lines
typeset -a grouped_paths grouped_labels grouped_tiers
typeset -a all_repo_paths all_repo_labels all_repo_tiers
typeset relative_path repo_path repo_tier desired_tier line key second third query=''
typeset -i selected=1 index

repo_paths=("${core_repo:A}")
repo_labels=("core-repo")
repo_tiers=("internal")
if ! command -v jq >/dev/null 2>&1; then
  print -u2 -- 'repo menu requires jq.'
  exit 1
fi

target_lines=("${(@f)$(command jq -r '
  [
    (.targets | to_entries[] | { path: .value.path, tier: .value.tier }),
    ((.auxiliary // {}) | to_entries[] | { path: .value.path, tier: "auxiliary" })
  ]
  | .[]
  | [.path, .tier]
  | @tsv
' "$targets_file")}")

if (( $? != 0 )); then
  print -u2 -- "Could not parse repo targets: $targets_file"
  exit 1
fi

for line in "${target_lines[@]}"; do
  IFS=$'\t' read -r relative_path repo_tier <<< "$line"
  repo_path="${core_repo:A}/$relative_path"
  repo_path="${repo_path:A}"
  repo_paths+=("$repo_path")
  repo_labels+=("${repo_path:t}")
  repo_tiers+=("$repo_tier")
done

for (( index = 1; index <= ${#repo_paths}; index += 1 )); do
  if [[ ${repo_tiers[$index]} != internal && ${repo_tiers[$index]} != client && ${repo_tiers[$index]} != auxiliary ]]; then
    print -u2 -- "Invalid repo classification for ${repo_labels[$index]}: ${repo_tiers[$index]:-(missing)}"
    exit 1
  fi
done

for desired_tier in internal client auxiliary; do
  for (( index = 1; index <= ${#repo_paths}; index += 1 )); do
    if [[ ${repo_tiers[$index]} == $desired_tier ]]; then
      grouped_paths+=("${repo_paths[$index]}")
      grouped_labels+=("${repo_labels[$index]}")
      grouped_tiers+=("${repo_tiers[$index]}")
    fi
  done
done

repo_paths=("${grouped_paths[@]}")
repo_labels=("${grouped_labels[@]}")
repo_tiers=("${grouped_tiers[@]}")
all_repo_paths=("${repo_paths[@]}")
all_repo_labels=("${repo_labels[@]}")
all_repo_tiers=("${repo_tiers[@]}")

if [[ ! -t 0 ]]; then
  print -u2 -- 'repo menu requires an interactive terminal.'
  exit 1
fi

fuzzy_matches() {
  typeset target=$1 needle=$2
  typeset -i target_index needle_index=1

  [[ -z $needle || $target == *$needle* ]] && return 0

  for (( target_index = 1; target_index <= ${#target}; target_index += 1 )); do
    if [[ ${target[$target_index]} == ${needle[$needle_index]} ]]; then
      (( needle_index += 1 ))
      (( needle_index > ${#needle} )) && return 0
    fi
  done

  return 1
}

match_quality() {
  typeset target=$1 needle=$2

  if [[ $target == $needle ]]; then
    REPLY=0
  elif [[ $target == ${needle}* ]]; then
    REPLY=1
  elif [[ $target == *${needle}* ]]; then
    REPLY=2
  elif fuzzy_matches "$target" "$needle"; then
    REPLY=3
  else
    return 1
  fi
}

filter_repos() {
  typeset normalized_query normalized_label desired_tier
  typeset -a match_qualities
  typeset -i quality
  normalized_query=${(L)query}
  normalized_query=${normalized_query//[!a-z0-9]/}
  repo_paths=()
  repo_labels=()
  repo_tiers=()

  if [[ -z $normalized_query ]]; then
    repo_paths=("${all_repo_paths[@]}")
    repo_labels=("${all_repo_labels[@]}")
    repo_tiers=("${all_repo_tiers[@]}")
    selected=1
    return
  fi

  for (( index = 1; index <= ${#all_repo_paths}; index += 1 )); do
    normalized_label=${(L)all_repo_labels[$index]}
    normalized_label=${normalized_label//[!a-z0-9]/}
    if match_quality "$normalized_label" "$normalized_query"; then
      match_qualities[$index]=$REPLY
    else
      match_qualities[$index]=-1
    fi
  done

  for desired_tier in internal client auxiliary; do
    for (( quality = 0; quality <= 3; quality += 1 )); do
      for (( index = 1; index <= ${#all_repo_paths}; index += 1 )); do
        if [[ ${all_repo_tiers[$index]} == $desired_tier ]] &&
          (( match_qualities[$index] == quality )); then
          repo_paths+=("${all_repo_paths[$index]}")
          repo_labels+=("${all_repo_labels[$index]}")
          repo_tiers+=("${all_repo_tiers[$index]}")
        fi
      done
    done
  done

  (( selected = ${#repo_paths} > 0 ? 1 : 0 ))
}

render_menu() {
  printf '\033[H\033[J\033[?25l\033[1;36mRepos\033[0m\n' >&2
  if [[ -n $query ]]; then
    printf 'Filter: %s  %d/%d\n\n' "$query" "${#repo_paths}" "${#all_repo_paths}" >&2
  else
    printf 'Filter: \033[2m(type to filter)\033[0m  %d/%d\n\n' "${#repo_paths}" "${#all_repo_paths}" >&2
  fi

  typeset previous_tier=''
  for (( index = 1; index <= ${#repo_paths}; index += 1 )); do
    if [[ ${repo_tiers[$index]} != $previous_tier ]]; then
      if [[ -n $previous_tier ]]; then
        printf '\n' >&2
      fi
      printf '\033[1;34m[%s]\033[0m\n' "${repo_tiers[$index]}" >&2
      previous_tier=${repo_tiers[$index]}
    fi

    if (( index == selected )); then
      printf '\033[36m> %s\033[0m\n' "${repo_labels[$index]}" >&2
    else
      printf '  %s\n' "${repo_labels[$index]}" >&2
    fi
  done

  if (( ${#repo_paths} == 0 )); then
    printf '\033[2mNo repos match "%s".\033[0m\n' "$query" >&2
  fi

  printf '\nup/down or j/k: navigate   type: filter   backspace: edit\n' >&2
  printf 'enter: select   esc: clear   q: quit\n' >&2
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
      if [[ -n $query ]]; then
        query=''
        filter_repos
        render_menu
        continue
      fi
      exit 0
    fi
  fi

  case "$key" in
    $'\e[A' | k)
      if (( ${#repo_paths} > 0 )); then
        (( selected = selected == 1 ? ${#repo_paths} : selected - 1 ))
      fi
      render_menu
      ;;
    $'\e[B' | j)
      if (( ${#repo_paths} > 0 )); then
        (( selected = selected == ${#repo_paths} ? 1 : selected + 1 ))
      fi
      render_menu
      ;;
    $'\r' | $'\n')
      if (( ${#repo_paths} > 0 )); then
        print -r -- "${repo_paths[$selected]}"
        exit 0
      fi
      ;;
    q | Q)
      exit 0
      ;;
    $'\x7f' | $'\b')
      query=${query%?}
      filter_repos
      render_menu
      ;;
    [[:print:]])
      query+=$key
      filter_repos
      render_menu
      ;;
  esac
done
