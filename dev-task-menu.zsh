#!/bin/zsh -f

# Fuzzy picker for dd. The menu is written to stderr so the selected task
# command can be placed in the calling Zsh prompt without running it.

emulate -L zsh
setopt no_aliases

typeset -a all_task_names all_task_descriptions
typeset -a task_names task_descriptions match_qualities
typeset output line name key second third query=''
typeset task_line_pattern='^\* ([^[:space:]]+):[[:space:]]*(.*)$'
typeset -i selected=1 scroll_offset=1 index

if [[ ! -t 0 ]]; then
  print -u2 -- 'dev task menu requires an interactive terminal.'
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
    name=${match[1]}
    if [[ $name == dev:* ]]; then
      all_task_names+=("$name")
      all_task_descriptions+=("${match[2]}")
    fi
  fi
done

if (( ${#all_task_names} == 0 )); then
  print -u2 -- 'No task dev:* commands found in the current directory.'
  exit 1
fi

task_names=("${all_task_names[@]}")
task_descriptions=("${all_task_descriptions[@]}")

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

filter_tasks() {
  typeset normalized_query normalized_name
  typeset -i quality
  normalized_query=${(L)query}
  normalized_query=${normalized_query//[!a-z0-9]/}
  task_names=()
  task_descriptions=()
  match_qualities=()

  if [[ -z $normalized_query ]]; then
    task_names=("${all_task_names[@]}")
    task_descriptions=("${all_task_descriptions[@]}")
    selected=1
    scroll_offset=1
    return
  fi

  for (( index = 1; index <= ${#all_task_names}; index += 1 )); do
    normalized_name=${(L)all_task_names[$index]}
    normalized_name=${normalized_name#dev:}
    normalized_name=${normalized_name//[!a-z0-9]/}
    if match_quality "$normalized_name" "$normalized_query"; then
      match_qualities[$index]=$REPLY
    else
      match_qualities[$index]=-1
    fi
  done

  for (( quality = 0; quality <= 3; quality += 1 )); do
    for (( index = 1; index <= ${#all_task_names}; index += 1 )); do
      if (( match_qualities[$index] == quality )); then
        task_names+=("${all_task_names[$index]}")
        task_descriptions+=("${all_task_descriptions[$index]}")
      fi
    done
  done

  (( selected = ${#task_names} > 0 ? 1 : 0 ))
  scroll_offset=1
}

visible_count() {
  typeset -i count=$(( ${LINES:-24} - 9 ))
  (( count < 3 )) && count=3
  (( count > 30 )) && count=30
  print -r -- "$count"
}

update_scroll() {
  typeset -i visible=$(visible_count)

  if (( selected < scroll_offset )); then
    scroll_offset=$selected
  elif (( selected >= scroll_offset + visible )); then
    scroll_offset=$(( selected - visible + 1 ))
  fi
}

render_menu() {
  typeset -i name_width=12 detail_width
  typeset -i visible=$(visible_count)
  typeset -i last=$(( scroll_offset + visible - 1 ))
  typeset display_name details

  (( last > ${#task_names} )) && last=${#task_names}

  for (( index = 1; index <= ${#task_names}; index += 1 )); do
    (( ${#task_names[$index]} > name_width )) && name_width=${#task_names[$index]}
  done
  (( name_width > 30 )) && name_width=30

  detail_width=$(( ${COLUMNS:-100} - name_width - 7 ))
  (( detail_width < 20 )) && detail_width=20

  printf '\033[H\033[J\033[?25l\033[1;36mDev tasks\033[0m\n' >&2
  if [[ -n $query ]]; then
    printf 'Filter: %s  %d/%d\n\n' "$query" "${#task_names}" "${#all_task_names}" >&2
  else
    printf 'Filter: \033[2m(type to filter)\033[0m  %d/%d\n\n' \
      "${#task_names}" "${#all_task_names}" >&2
  fi

  for (( index = scroll_offset; index <= last; index += 1 )); do
    display_name=${task_names[$index]}
    details=${task_descriptions[$index]}
    if (( ${#display_name} > name_width )); then
      display_name="${display_name[1,$(( name_width - 1 ))]}…"
    fi
    if (( ${#details} > detail_width )); then
      details="${details[1,$(( detail_width - 1 ))]}…"
    fi

    if (( index == selected )); then
      printf '\033[36m> \033[1;37m%-*s\033[0m  \033[36m%s\033[0m\n' \
        "$name_width" "$display_name" "$details" >&2
    else
      printf '  %-*s  \033[2m%s\033[0m\n' \
        "$name_width" "$display_name" "$details" >&2
    fi
  done

  if (( ${#task_names} == 0 )); then
    printf '\033[2mNo dev tasks match "%s".\033[0m\n' "$query" >&2
  elif (( ${#task_names} > visible )); then
    printf '\n\033[2mShowing %d-%d of %d tasks\033[0m\n' \
      "$scroll_offset" "$last" "${#task_names}" >&2
  fi

  printf '\nup/down or j/k: navigate   type: filter   backspace: edit\n' >&2
  printf 'enter: insert command   esc: clear   q: quit\n' >&2
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
        filter_tasks
        render_menu
        continue
      fi
      exit 0
    fi
  fi

  case "$key" in
    $'\e[A' | k)
      if (( ${#task_names} > 0 )); then
        (( selected = selected == 1 ? ${#task_names} : selected - 1 ))
        update_scroll
      fi
      render_menu
      ;;
    $'\e[B' | j)
      if (( ${#task_names} > 0 )); then
        (( selected = selected == ${#task_names} ? 1 : selected + 1 ))
        update_scroll
      fi
      render_menu
      ;;
    $'\r' | $'\n')
      if (( ${#task_names} > 0 )); then
        print -r -- "task ${task_names[$selected]}"
        exit 0
      fi
      ;;
    q | Q)
      exit 0
      ;;
    $'\x7f' | $'\b')
      query=${query%?}
      filter_tasks
      render_menu
      ;;
    [[:print:]])
      query+=$key
      filter_tasks
      render_menu
      ;;
  esac
done
