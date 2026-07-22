# Lean Zsh profile used only by Ghostty.

# The custom ZDOTDIR keeps this shell isolated, so load Ghostty's integration
# explicitly. Its initialization guard makes this safe if it was auto-injected.
if [[ -n "$GHOSTTY_RESOURCES_DIR" && \
  -r "$GHOSTTY_RESOURCES_DIR/shell-integration/zsh/ghostty-integration" ]]; then
  source "$GHOSTTY_RESOURCES_DIR/shell-integration/zsh/ghostty-integration"
fi

bindkey -e

setopt AUTO_CD
setopt AUTO_PUSHD
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_REDUCE_BLANKS
setopt INC_APPEND_HISTORY
setopt INTERACTIVE_COMMENTS
setopt SHARE_HISTORY

HISTFILE="$HOME/.zsh_history"
HISTSIZE=100000
SAVEHIST=100000

# Load secrets without exposing them in this tracked file.
for secrets_file in "$HOME/.secrets" "$HOME/.secrets-custom"; do
  if [[ -r "$secrets_file" ]]; then
    set -a
    source "$secrets_file"
    set +a
  fi
done
unset secrets_file

# Autoload completions. Bun's completion file stays unloaded until requested.
# Homebrew provides completions for installed tools such as Sesh.
if [[ -d /opt/homebrew/share/zsh/site-functions ]]; then
  fpath=(/opt/homebrew/share/zsh/site-functions $fpath)
fi
fpath=("$HOME/.bun" $fpath)
autoload -Uz compinit
zcompdump_dir="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/ghostty"
[[ -d "$zcompdump_dir" ]] || mkdir -p "$zcompdump_dir"
zcompdump_file="$zcompdump_dir/.zcompdump"
if [[ -r "$zcompdump_file" ]]; then
  compinit -C -d "$zcompdump_file"
else
  compinit -d "$zcompdump_file"
fi
if (( $+commands[sesh] )); then
  autoload -Uz _sesh
  compdef _sesh sesh
fi
unset zcompdump_dir zcompdump_file
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'

# Keep fnm's per-project Node switching. It adds only a few milliseconds.
if (( $+commands[fnm] )); then
  eval "$(fnm env --use-on-cd --shell zsh)"
fi

# Load the single tracked shortcut entry point once.
[[ -r "$HOME/.bash_aliases" ]] && source "$HOME/.bash_aliases"

unalias ohmyzsh 2>/dev/null

# Match the useful parts of the previous robbyrussell prompt with one Git
# status call: command result, current directory, branch, and dirty state.
setopt PROMPT_SUBST
typeset -g GHOSTTY_GIT_PROMPT=

update_ghostty_git_prompt() {
  local git_status branch
  git_status=$(GIT_OPTIONAL_LOCKS=0 command git status \
    --porcelain=v1 --branch --untracked-files=normal 2>/dev/null) || {
    GHOSTTY_GIT_PROMPT=
    return
  }

  branch="${git_status%%$'\n'*}"
  branch="${branch#'## '}"
  case "$branch" in
    'No commits yet on '*) branch="${branch#'No commits yet on '}" ;;
    'Initial commit on '*) branch="${branch#'Initial commit on '}" ;;
    'HEAD (no branch)'*)
      branch=$(command git rev-parse --short HEAD 2>/dev/null)
      ;;
    *)
      branch="${branch%%...*}"
      branch="${branch%% *}"
      ;;
  esac
  branch="${branch//\%/%%}"

  GHOSTTY_GIT_PROMPT=" %F{blue}git:(%F{red}${branch}%F{blue})%f"
  if [[ $git_status == *$'\n'* ]]; then
    GHOSTTY_GIT_PROMPT+=" %F{yellow}✗%f"
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd update_ghostty_git_prompt

# Use the current directory as the idle tab/window title. This only runs when
# the prompt returns, so agents and other foreground programs can set their own
# title for as long as they are running.
update_ghostty_title() {
  print -Pn -- $'\e]2;%1~\a'
}
add-zsh-hook precmd update_ghostty_title

# Keep the full informational portion bold for stronger readability while
# resetting the style before command input begins.
PROMPT='%(?.%B%F{green}➜.%B%F{red}➜)%b%f  %B%F{cyan}%1~%f${GHOSTTY_GIT_PROMPT}%b '
RPROMPT=

if [[ -r "$HOME/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh" ]]; then
  ZSH_AUTOSUGGEST_STRATEGY=(history)
  ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20
  ZSH_AUTOSUGGEST_MANUAL_REBIND=1
  source "$HOME/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh"

  # Accept visible ghost text with Tab; preserve normal completion when there
  # is no autosuggestion to accept.
  _ghostty_tab_accept_or_complete() {
    if [[ -n "$POSTDISPLAY" ]]; then
      zle autosuggest-accept
    else
      zle expand-or-complete
    fi
  }
  zle -N _ghostty_tab_accept_or_complete
  ZSH_AUTOSUGGEST_IGNORE_WIDGETS+=(_ghostty_tab_accept_or_complete)
  bindkey '^I' _ghostty_tab_accept_or_complete
fi

# Syntax highlighting must be loaded last.
if [[ -r "$HOME/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]]; then
  source "$HOME/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
fi
