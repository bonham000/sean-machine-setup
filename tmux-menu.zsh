#!/bin/zsh -f

# Fast tmux session manager for tmx.

emulate -L zsh
setopt no_aliases

typeset -a session_ids session_names session_details
typeset key second third status_message
typeset -i selected=1 scroll_offset=1

if [[ ! -t 0 ]]; then
  print -u2 -- 'tmx requires an interactive terminal.'
  exit 1
fi

if (( ! $+commands[tmux] )); then
  print -u2 -- 'tmux not found on PATH.'
  exit 1
fi

load_sessions() {
  local format output line remainder

  session_ids=()
  session_names=()
  session_details=()

  format='#{session_id}'$'\t''#{session_name}'$'\t''#{session_windows} windows • #{?session_attached,attached,detached} • #{session_path}'
  output=$(command tmux list-sessions -F "$format" 2>/dev/null) || return 1

  for line in "${(@f)output}"; do
    session_ids+=("${line%%$'\t'*}")
    remainder="${line#*$'\t'}"
    session_names+=("${remainder%%$'\t'*}")
    session_details+=("${remainder#*$'\t'}")
  done

  (( ${#session_ids} > 0 ))
}

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

  (( last > ${#session_ids} )) && last=${#session_ids}

  for (( index = 1; index <= ${#session_names}; index += 1 )); do
    (( ${#session_names[$index]} > name_width )) && name_width=${#session_names[$index]}
  done
  (( name_width > 30 )) && name_width=30

  detail_width=$(( ${COLUMNS:-100} - name_width - 7 ))
  (( detail_width < 20 )) && detail_width=20

  printf '\033[H\033[J\033[?25l\033[1;36mtmux Sessions\033[0m\n\n'

  for (( index = scroll_offset; index <= last; index += 1 )); do
    name=${session_names[$index]}
    details=${session_details[$index]}
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

  if (( ${#session_ids} > visible )); then
    printf '\n\033[2mShowing %d-%d of %d sessions\033[0m\n' \
      "$scroll_offset" "$last" "${#session_ids}"
  fi

  [[ -n $status_message ]] && printf '\n\033[33m%s\033[0m\n' "$status_message"
  printf '\nup/down or j/k: navigate   enter: attach/switch   x: kill   q: quit\n'
}

cleanup() {
  printf '\033[?25h\033[H\033[J'
}

connect_selected() {
  local target=${session_ids[$selected]}

  cleanup
  trap - EXIT INT TERM HUP

  if [[ -n ${TMUX:-} ]]; then
    command tmux switch-client -t "$target"
    exit $?
  fi

  exec tmux attach-session -t "$target"
}

kill_selected() {
  local target=${session_ids[$selected]}
  local name=${session_names[$selected]}
  local current_session

  if [[ -n ${TMUX:-} ]]; then
    current_session=$(command tmux display-message -p '#{session_id}' 2>/dev/null)
    if [[ $current_session == $target ]]; then
      status_message="Switch to another session before killing '$name'."
      return
    fi
  fi

  if command tmux kill-session -t "$target" 2>/dev/null; then
    status_message="Killed session '$name'."
  else
    status_message="Could not kill session '$name'."
    return
  fi

  if ! load_sessions; then
    cleanup
    trap - EXIT INT TERM HUP
    print -r -- "Killed session '$name'. No tmux sessions remain."
    exit 0
  fi

  (( selected > ${#session_ids} )) && selected=${#session_ids}
  (( scroll_offset > selected )) && scroll_offset=$selected
  update_scroll
}

if ! load_sessions; then
  print -r -- 'No tmux sessions are running.'
  exit 0
fi

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
      (( selected = selected == 1 ? ${#session_ids} : selected - 1 ))
      update_scroll
      ;;
    $'\e[B' | j)
      (( selected = selected == ${#session_ids} ? 1 : selected + 1 ))
      update_scroll
      ;;
    $'\r' | $'\n')
      connect_selected
      ;;
    x)
      kill_selected
      ;;
    q)
      exit 0
      ;;
  esac

  render_menu
done
