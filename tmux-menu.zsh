#!/bin/zsh -f

# Fast tmux session manager for tmx.

emulate -L zsh
setopt no_aliases

typeset -a session_ids session_names session_windows session_states
typeset -a session_activities session_pane_ids session_paths session_commands
typeset -a session_roots
typeset key second third status_message
typeset -i selected=1 scroll_offset=1 preview_enabled=1 loaded_at=0

if [[ ! -t 0 ]]; then
  print -u2 -- 'tmx requires an interactive terminal.'
  exit 1
fi

if (( ! $+commands[tmux] )); then
  print -u2 -- 'tmux not found on PATH.'
  exit 1
fi

load_sessions() {
  local format output line remainder id name windows state activity pane_id working_path command root

  session_ids=()
  session_names=()
  session_windows=()
  session_states=()
  session_activities=()
  session_pane_ids=()
  session_paths=()
  session_commands=()
  session_roots=()
  loaded_at=$(command date +%s)

  format='#{session_id}'$'\t''#{session_name}'$'\t''#{session_windows}'$'\t''#{?session_attached,attached,detached}'$'\t''#{session_activity}'$'\t''#{pane_id}'$'\t''#{pane_current_path}'$'\t''#{pane_current_command}'$'\t''#{@tmx_root}'$'\t''#{session_path}'
  output=$(command tmux list-sessions -F "$format" 2>/dev/null) || return 1

  for line in "${(@f)output}"; do
    id="${line%%$'\t'*}"
    remainder="${line#*$'\t'}"
    name="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    windows="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    state="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    activity="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    pane_id="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    working_path="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    command="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"
    root="${remainder%%$'\t'*}"
    remainder="${remainder#*$'\t'}"

    [[ -z $root ]] && root=$remainder
    [[ -z $root ]] && root=$working_path

    session_ids+=("$id")
    session_names+=("$name")
    session_windows+=("$windows")
    session_states+=("$state")
    session_activities+=("$activity")
    session_pane_ids+=("$pane_id")
    session_paths+=("$working_path")
    session_commands+=("${command:-shell}")
    session_roots+=("$root")
  done

  (( ${#session_ids} > 0 ))
}

session_base_for_directory() {
  local directory=${1:A}
  local name=${directory:t}

  [[ $directory == / ]] && name=root
  name=${name:l}
  name=${name//[^[:alnum:]_-]/-}
  while [[ $name == *--* ]]; do
    name=${name//--/-}
  done
  while [[ $name == -* ]]; do
    name=${name#-}
  done
  while [[ $name == *- ]]; do
    name=${name%-}
  done
  [[ -z $name ]] && name=session
  (( ${#name} > 48 )) && name=${name[1,48]}

  print -r -- "$name"
}

session_name_taken() {
  local candidate=$1 existing

  for existing in "${session_names[@]}"; do
    [[ $existing == $candidate ]] && return 0
  done
  return 1
}

next_session_name() {
  local base=$1 candidate=$1
  local -i suffix=2

  while session_name_taken "$candidate"; do
    candidate="$base-$suffix"
    (( suffix += 1 ))
  done

  print -r -- "$candidate"
}

format_activity() {
  local activity=$1
  local -i elapsed

  if [[ $activity != <-> ]]; then
    print -r -- 'activity unknown'
    return
  fi

  elapsed=$(( loaded_at - activity ))
  (( elapsed < 0 )) && elapsed=0

  if (( elapsed < 60 )); then
    print -r -- 'active now'
  elif (( elapsed < 3600 )); then
    print -r -- "$(( elapsed / 60 ))m ago"
  elif (( elapsed < 86400 )); then
    print -r -- "$(( elapsed / 3600 ))h ago"
  else
    print -r -- "$(( elapsed / 86400 ))d ago"
  fi
}

format_path() {
  local root=$1 working_path=$2

  if [[ -n $root && $working_path == $root ]]; then
    print -r -- '.'
  elif [[ -n $root && $working_path == "$root"/* ]]; then
    print -r -- "${working_path#$root/}"
  elif [[ -n ${HOME:-} && $working_path == "$HOME" ]]; then
    print -r -- '~'
  elif [[ -n ${HOME:-} && $working_path == "$HOME"/* ]]; then
    print -r -- "~/${working_path#$HOME/}"
  else
    print -r -- "$working_path"
  fi
}

session_details() {
  local -i index=$1 windows=${session_windows[$1]:-1}
  local window_label=windows
  local location activity details

  (( windows == 1 )) && window_label=window
  location=$(format_path "${session_roots[$index]}" "${session_paths[$index]}")
  activity=$(format_activity "${session_activities[$index]}")
  details="${session_commands[$index]}"
  [[ -n $location && $location != . ]] && details+=" • $location"
  details+=" • $activity • ${session_states[$index]} • $windows $window_label"

  print -r -- "$details"
}

preview_height() {
  local -i height=0

  if (( preview_enabled && ${#session_ids} > 0 && ${LINES:-24} >= 18 )); then
    height=$(( ${LINES:-24} - 16 ))
    (( height > 6 )) && height=6
  fi

  print -r -- "$height"
}

visible_count() {
  local -i count=$(( ${LINES:-24} - $(preview_height) - 10 ))
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

render_preview() {
  local pane_id=${session_pane_ids[$selected]}
  local output line
  local -a lines
  local -i height=$(preview_height) width=${COLUMNS:-100} start index

  (( height == 0 )) && return

  printf '\n\033[2mPreview — %s\033[0m\n' "${session_names[$selected]}"
  output=$(command tmux capture-pane -p -J -t "$pane_id" 2>/dev/null)
  lines=("${(@f)output}")

  if (( ${#lines} == 0 )); then
    printf '\033[2m  No visible output.\033[0m\n'
    return
  fi

  start=$(( ${#lines} - height + 1 ))
  (( start < 1 )) && start=1

  for (( index = start; index <= ${#lines}; index += 1 )); do
    line=${lines[$index]//$'\t'/    }
    if (( ${#line} > width - 3 )); then
      line="${line[1,$(( width - 4 ))]}…"
    fi
    printf '\033[2m  %s\033[0m\n' "$line"
  done
}

render_empty_state() {
  local root=${PWD:A}
  local base=$(session_base_for_directory "$root")
  local name=$(next_session_name "$base")
  local location=$(format_path '' "$root")

  printf '\033[H\033[J\033[?25l\033[1;36mtmux Sessions\033[0m\n\n'
  printf '\033[2mNo tmux sessions are running.\033[0m\n\n'
  printf '\033[36m> \033[1;37mCreate %-20s\033[0m  \033[36m%s\033[0m\n' "$name" "$location"
  [[ -n $status_message ]] && printf '\n\033[33m%s\033[0m\n' "$status_message"
  printf '\nenter: create and attach   q: quit\n'
}

render_menu() {
  local -i index name_width=12 detail_width
  local -i visible last
  local name details

  if (( ${#session_ids} == 0 )); then
    render_empty_state
    return
  fi

  visible=$(visible_count)
  last=$(( scroll_offset + visible - 1 ))
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
    details=$(session_details "$index")
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
  render_preview
  printf '\nup/down or j/k: navigate   enter: attach/switch   n: new   p: preview   x: kill   q: quit\n'
}

cleanup() {
  printf '\033[?25h\033[H\033[J'
}

connect_target() {
  local target=$1

  cleanup
  trap - EXIT INT TERM HUP

  if [[ -n ${TMUX:-} ]]; then
    command tmux switch-client -t "$target"
    exit $?
  fi

  exec tmux attach-session -t "$target"
}

connect_selected() {
  connect_target "${session_ids[$selected]}"
}

create_session() {
  local root=${PWD:A}
  local base name target

  load_sessions || true
  base=$(session_base_for_directory "$root")
  name=$(next_session_name "$base")

  if ! target=$(command tmux new-session -d -P -F '#{session_id}' -s "$name" -c "$root" 2>/dev/null); then
    status_message="Could not create session '$name'."
    load_sessions || true
    return
  fi

  command tmux set-option -t "$target" @tmx_root "$root" >/dev/null 2>&1 || true
  connect_target "$target"
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

  load_sessions || true
  if (( ${#session_ids} == 0 )); then
    selected=1
    scroll_offset=1
    status_message="Killed session '$name'. No tmux sessions remain."
    return
  fi

  (( selected > ${#session_ids} )) && selected=${#session_ids}
  (( scroll_offset > selected )) && scroll_offset=$selected
  update_scroll
}

select_current_directory_session() {
  local root=${PWD:A}
  local -i index

  for (( index = 1; index <= ${#session_roots}; index += 1 )); do
    if [[ ${session_roots[$index]:A} == $root ]]; then
      selected=$index
      update_scroll
      return
    fi
  done
}

load_sessions || true
select_current_directory_session

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
      if (( ${#session_ids} > 0 )); then
        (( selected = selected == 1 ? ${#session_ids} : selected - 1 ))
        update_scroll
      fi
      ;;
    $'\e[B' | j)
      if (( ${#session_ids} > 0 )); then
        (( selected = selected == ${#session_ids} ? 1 : selected + 1 ))
        update_scroll
      fi
      ;;
    $'\r' | $'\n')
      if (( ${#session_ids} > 0 )); then
        connect_selected
      else
        create_session
      fi
      ;;
    n)
      create_session
      ;;
    p)
      if (( ${#session_ids} > 0 )); then
        (( preview_enabled = ! preview_enabled ))
        update_scroll
      fi
      ;;
    x)
      (( ${#session_ids} > 0 )) && kill_selected
      ;;
    q)
      exit 0
      ;;
  esac

  render_menu
done
