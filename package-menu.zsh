#!/bin/zsh -f

# Fast package.json script picker for rn and jf.

emulate -L zsh
setopt no_aliases

typeset -a script_names script_commands
typeset key second third output line
typeset -i selected=1 scroll_offset=1

if [[ ! -t 0 ]]; then
  print -u2 -- 'package script menu requires an interactive terminal.'
  exit 1
fi

if [[ ! -r package.json ]]; then
  print -u2 -- 'package.json not found in the current directory.'
  exit 1
fi

if (( ! $+commands[jq] )); then
  print -u2 -- 'jq not found on PATH.'
  exit 1
fi

if (( ! $+commands[bun] )); then
  print -u2 -- 'bun not found on PATH.'
  exit 1
fi

if ! output=$(command jq -r \
  '.scripts // {} | to_entries | sort_by(.key)[] | [.key, .value] | @tsv' \
  package.json 2>/dev/null); then
  print -u2 -- 'Could not read scripts from package.json.'
  exit 1
fi

if [[ -z $output ]]; then
  print -u2 -- 'No scripts found in package.json.'
  exit 1
fi

for line in "${(@f)output}"; do
  [[ $line == *$'\t'* ]] || continue
  script_names+=("${line%%$'\t'*}")
  script_commands+=("${line#*$'\t'}")
done

if (( ${#script_names} == 0 )); then
  print -u2 -- 'No scripts found in package.json.'
  exit 1
fi

visible_count() {
  local -i count=$(( ${LINES:-24} - 8 ))
  (( count < 3 )) && count=3
  (( count > 30 )) && count=30
  print -r -- "$count"
}

update_scroll() {
  local -i visible=$(visible_count)

  if (( selected < scroll_offset )); then
    scroll_offset=$selected
  elif (( selected >= scroll_offset + visible )); then
    scroll_offset=$(( selected - visible + 1 ))
  fi
}

render_menu() {
  local -i index name_width=12 detail_width
  local -i visible=$(visible_count)
  local -i last=$(( scroll_offset + visible - 1 ))
  local name details

  (( last > ${#script_names} )) && last=${#script_names}

  for (( index = 1; index <= ${#script_names}; index += 1 )); do
    (( ${#script_names[$index]} > name_width )) && name_width=${#script_names[$index]}
  done
  (( name_width > 30 )) && name_width=30

  detail_width=$(( ${COLUMNS:-100} - name_width - 7 ))
  (( detail_width < 20 )) && detail_width=20

  printf '\033[H\033[J\033[?25l\033[1;36mPackage Scripts\033[0m\n\n'

  for (( index = scroll_offset; index <= last; index += 1 )); do
    name=${script_names[$index]}
    details=${script_commands[$index]}
    if (( ${#name} > name_width )); then
      name="${name[1,$(( name_width - 1 ))]}…"
    fi
    if (( ${#details} > detail_width )); then
      details="${details[1,$(( detail_width - 1 ))]}…"
    fi

    if (( index == selected )); then
      printf '\033[36m> \033[1;37m%-*s\033[0m  \033[36m%s\033[0m\n' \
        "$name_width" "$name" "$details"
    else
      printf '  %-*s  \033[2m%s\033[0m\n' "$name_width" "$name" "$details"
    fi
  done

  if (( ${#script_names} > visible )); then
    printf '\n\033[2mShowing %d-%d of %d scripts\033[0m\n' \
      "$scroll_offset" "$last" "${#script_names}"
  fi

  printf '\nup/down or j/k: navigate   enter: run   q: quit\n'
}

cleanup() {
  printf '\033[?25h\033[H\033[J'
}

run_selected() {
  local name=${script_names[$selected]}

  cleanup
  trap - EXIT INT TERM HUP
  printf '\033[36mRunning package script:\033[0m \033[32m%s\033[0m\n' "$name"
  command bun run "$name"
  exit $?
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
      (( selected = selected == 1 ? ${#script_names} : selected - 1 ))
      update_scroll
      ;;
    $'\e[B' | j)
      (( selected = selected == ${#script_names} ? 1 : selected + 1 ))
      update_scroll
      ;;
    $'\r' | $'\n')
      run_selected
      ;;
    q)
      exit 0
      ;;
  esac

  render_menu
done
