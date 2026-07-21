#!/bin/zsh -f

# Fast Taskfile picker for tm.

emulate -L zsh
setopt no_aliases

typeset -a task_names task_descriptions
typeset key second third output line
typeset task_line_pattern='^\* ([^[:space:]]+):[[:space:]]*(.*)$'
typeset -i selected=1 scroll_offset=1

if [[ ! -t 0 ]]; then
  print -u2 -- 'task menu requires an interactive terminal.'
  exit 1
fi

if (( ! $+commands[task] )); then
  print -u2 -- 'task not found on PATH.'
  exit 1
fi

if ! output=$(NO_COLOR=1 command task --list-all 2>/dev/null); then
  print -u2 -- 'Could not list Taskfile tasks.'
  exit 1
fi

for line in "${(@f)output}"; do
  if [[ $line =~ $task_line_pattern ]]; then
    task_names+=("${match[1]}")
    task_descriptions+=("${match[2]}")
  fi
done

if (( ${#task_names} == 0 )); then
  print -u2 -- 'No tasks found in the current directory.'
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

  (( last > ${#task_names} )) && last=${#task_names}

  for (( index = 1; index <= ${#task_names}; index += 1 )); do
    (( ${#task_names[$index]} > name_width )) && name_width=${#task_names[$index]}
  done
  (( name_width > 30 )) && name_width=30

  detail_width=$(( ${COLUMNS:-100} - name_width - 7 ))
  (( detail_width < 20 )) && detail_width=20

  printf '\033[H\033[J\033[?25l\033[1;36mTasks\033[0m\n\n'

  for (( index = scroll_offset; index <= last; index += 1 )); do
    name=${task_names[$index]}
    details=${task_descriptions[$index]}
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

  if (( ${#task_names} > visible )); then
    printf '\n\033[2mShowing %d-%d of %d tasks\033[0m\n' \
      "$scroll_offset" "$last" "${#task_names}"
  fi

  printf '\nup/down or j/k: navigate   enter: run   q: quit\n'
}

cleanup() {
  printf '\033[?25h\033[H\033[J'
}

run_selected() {
  local name=${task_names[$selected]}

  cleanup
  trap - EXIT INT TERM HUP
  printf '\033[36mRunning task:\033[0m \033[32m%s\033[0m\n' "$name"
  command task "$name"
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
      (( selected = selected == 1 ? ${#task_names} : selected - 1 ))
      update_scroll
      ;;
    $'\e[B' | j)
      (( selected = selected == ${#task_names} ? 1 : selected + 1 ))
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
