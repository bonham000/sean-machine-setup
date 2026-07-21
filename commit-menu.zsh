#!/bin/zsh -f

# Fast commit message picker for ff.

emulate -L zsh
setopt no_aliases

typeset -a messages tags
typeset key second third
typeset -i selected=1

messages=(
  'Quick fix'
  'Code linting and formatting'
  'Documentation updates'
  'Update lockfile'
  'Grabbag of a lot of changes'
)
tags=(fix style docs deps misc)

if [[ ! -t 0 ]]; then
  print -u2 -- 'ff requires an interactive terminal.'
  exit 1
fi

if (( ! $+commands[git] )); then
  print -u2 -- 'git not found on PATH.'
  exit 1
fi

render_menu() {
  local -i index label_width=12 detail_width
  local label detail

  for (( index = 1; index <= ${#messages}; index += 1 )); do
    (( ${#messages[$index]} > label_width )) && label_width=${#messages[$index]}
  done

  detail_width=$(( ${COLUMNS:-100} - label_width - 7 ))
  (( detail_width < 8 )) && detail_width=8

  printf '\033[H\033[J\033[?25l\033[1;36mQuick Commit\033[0m\n\n'

  for (( index = 1; index <= ${#messages}; index += 1 )); do
    label=${messages[$index]}
    detail="[${tags[$index]}]"
    if (( index == selected )); then
      printf '\033[36m> \033[1;37m%-*s\033[0m  \033[36m%-*s\033[0m\n' \
        "$label_width" "$label" "$detail_width" "$detail"
    else
      printf '  %-*s  \033[2m%-*s\033[0m\n' \
        "$label_width" "$label" "$detail_width" "$detail"
    fi
  done

  printf '\nup/down or j/k: navigate   enter: commit   q: quit\n'
}

cleanup() {
  printf '\033[?25h\033[H\033[J'
}

commit_selected() {
  local message=${messages[$selected]}

  cleanup
  trap - EXIT INT TERM HUP
  printf '\033[36mRunning:\033[0m git add . && git commit -m %s\n' "${(q)message}"

  if ! command git add .; then
    print -u2 -- 'git add failed.'
    exit 1
  fi

  command git commit -m "$message"
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
      (( selected = selected == 1 ? ${#messages} : selected - 1 ))
      ;;
    $'\e[B' | j)
      (( selected = selected == ${#messages} ? 1 : selected + 1 ))
      ;;
    $'\r' | $'\n')
      commit_selected
      ;;
    q)
      exit 0
      ;;
  esac

  render_menu
done
