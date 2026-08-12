#!/bin/zsh -f

# Fast and fuzzy commit message picker for ff.

emulate -L zsh
setopt no_aliases

typeset -a all_messages all_tags
typeset -a messages tags match_qualities
typeset key second third query=''
typeset -i selected=1 scroll_offset=1 index

all_messages=(
  'Quick fix'
  'Formatting fix'
  'Documentation updates'
  'Fix test(s)'
  'Update Bun lockfile'
  'Grabbag/misc. changes'
)
all_tags=(fix style docs test chore misc)

messages=(${all_messages[@]})
tags=(${all_tags[@]})

if [[ ! -t 0 ]]; then
  print -u2 -- 'ff requires an interactive terminal.'
  exit 1
fi

if (( ! $+commands[git] )); then
  print -u2 -- 'git not found on PATH.'
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

filter_messages() {
  typeset normalized_query normalized_message normalized_tag normalized_target
  typeset -i idx
  typeset -i quality

  normalized_query=${(L)query}
  normalized_query=${normalized_query//[!a-z0-9]/}

  messages=()
  tags=()
  match_qualities=()

  if [[ -z $normalized_query ]]; then
    messages=(${all_messages[@]})
    tags=(${all_tags[@]})
    selected=1
    scroll_offset=1
    return
  fi

  for (( idx = 1; idx <= ${#all_messages}; idx += 1 )); do
    normalized_message=${(L)all_messages[$idx]}
    normalized_message=${normalized_message//[!a-z0-9]/}
    normalized_tag=${(L)all_tags[$idx]}
    normalized_tag=${normalized_tag//[!a-z0-9]/}
    normalized_target="${normalized_message} ${normalized_tag}"

    if match_quality "$normalized_target" "$normalized_query"; then
      match_qualities[$idx]=$REPLY
    else
      match_qualities[$idx]=-1
    fi
  done

  for quality in 0 1 2 3; do
    for (( idx = 1; idx <= ${#all_messages}; idx += 1 )); do
      if (( match_qualities[$idx] == quality )); then
        messages+=(${all_messages[$idx]})
        tags+=(${all_tags[$idx]})
      fi
    done
  done

  (( selected = ${#messages} > 0 ? 1 : 0 ))
  scroll_offset=1
}

visible_count() {
  typeset -i count=$(( ${LINES:-24} - 9 ))
  (( count < 3 )) && count=3
  (( count > 20 )) && count=20
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
  typeset -i message_width=22
  typeset -i visible=$(visible_count)
  typeset -i last=$(( scroll_offset + visible - 1 ))
  typeset message tag

  (( last > ${#messages} )) && last=${#messages}

  for (( index = 1; index <= ${#messages}; index += 1 )); do
    (( ${#messages[$index]} > message_width )) && message_width=${#messages[$index]}
  done

  (( message_width > 40 )) && message_width=40

  printf '\033[H\033[J\033[?25l\033[1;36mQuick Commit\033[0m\n' >&2
  if [[ -n $query ]]; then
    printf 'Filter: %s  %d/%d\n\n' "$query" "${#messages}" "${#all_messages}" >&2
  else
    printf 'Filter: \033[2m(type to filter)\033[0m  %d/%d\n\n' "${#messages}" "${#all_messages}" >&2
  fi

  for (( index = scroll_offset; index <= last; index += 1 )); do
    message=${messages[$index]}
    tag=${tags[$index]}

    if (( ${#message} > message_width )); then
      message="${message[1,$(( message_width - 1 ))]}…"
    fi

    if (( index == selected )); then
      printf '\033[36m> \033[1;37m%-*s\033[0m  [\033[36m%s\033[0m]\n' \
        "$message_width" "$message" "$tag" >&2
    else
      printf '  %-*s  [\033[2m%s\033[0m]\n' \
        "$message_width" "$message" "$tag" >&2
    fi
  done

  if (( ${#messages} == 0 )); then
    printf '\033[2mNo commit messages match "%s".\033[0m\n' "$query" >&2
  elif (( ${#messages} > visible )); then
    printf '\n\033[2mShowing %d-%d of %d messages\033[0m\n' \
      "$scroll_offset" "$last" "${#messages}" >&2
  fi

  printf '\nup/down or j/k: navigate   type: filter   backspace: edit\n' >&2
  printf 'enter: commit   esc: clear query   q: quit\n' >&2
}

cleanup() {
  printf '\033[?25h\033[H\033[J' >&2
}

commit_selected() {
  local message=${messages[$selected]}

  cleanup
  trap - EXIT INT TERM HUP
  printf '\033[36mRunning:\033[0m git add . && git commit -m %q\n' "$message"

  if ! command git add .; then
    print -u2 -- 'git add failed.'
    exit 1
  fi

  command git commit -m "$message"
  exit $?
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

filter_messages
render_menu

while IFS= read -rsk1 key; do
  if [[ $key == $'\e' ]]; then
    if IFS= read -rsk1 -t 0.03 second && [[ $second == '[' ]] &&
      IFS= read -rsk1 -t 0.03 third; then
      key="$key$second$third"
    else
      if [[ -n $query ]]; then
        query=''
        filter_messages
        render_menu
        continue
      fi
      exit 0
    fi
  fi

  case "$key" in
    $'\e[A' | k)
      if (( ${#messages} > 0 )); then
        (( selected = selected == 1 ? ${#messages} : selected - 1 ))
        update_scroll
      fi
      render_menu
      ;;
    $'\e[B' | j)
      if (( ${#messages} > 0 )); then
        (( selected = selected == ${#messages} ? 1 : selected + 1 ))
        update_scroll
      fi
      render_menu
      ;;
    $'\r' | $'\n')
      if (( ${#messages} > 0 )); then
        commit_selected
      fi
      ;;
    q | Q)
      exit 0
      ;;
    $'\x7f' | $'\b')
      query=${query%?}
      filter_messages
      render_menu
      ;;
    [[:print:]])
      query+=$key
      filter_messages
      render_menu
      ;;
  esac
done