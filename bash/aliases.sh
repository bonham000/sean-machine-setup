#!/bin/bash
# Shared aliases for bash and zsh
# This file is automatically sourced on every prompt

# Navigation aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

# Git aliases (short versions)
alias g='git'
alias gs='git status'
alias gst='git status'
alias ga='git add'
alias gc='git commit'
alias gp='git pull --rebase'
alias gpl='git pull'
alias rr='git pull --rebase'
alias gg='git push'
alias gco='git checkout'
alias gb='git branch'
alias gm='git merge'
alias gd='git diff'
alias gl='git log --oneline --graph --decorate'
alias nk='git stash && git stash clear'
alias bc='git branch | grep -v '\''main'\'' | grep -v '\''development'\'' | xargs git branch -d'

# Package manager aliases
alias y='yarn'
alias b='bun'
alias p='pnpm'
alias n='npm'

# Python aliases
alias py='python'
alias py3='python3'
alias pip='pip3'
alias venv='python -m venv'
alias activate='source venv/bin/activate'

# Docker aliases
alias dc='docker-compose'
alias dps='docker ps'
alias di='docker images'

# Utility aliases
alias c='code .'
alias v='vim'
alias ta='tmux attach'
alias reload='source ~/.zshrc'
alias zshconfig='vim ~/.zshrc'
alias ohmyzsh='vim ~/.oh-my-zsh'

# Custom Aliases
alias y='yarn'
alias b='bun'
alias p='pnpm'
alias c='cursor .'
alias code='code .'
alias x='code-insiders .'
alias nk='git stash && git stash clear'
alias t='task check'
alias ts='bun run tsc'
alias bc='bun run check'
alias tc='task check'

alias d='bun run dev'
alias s='bun run start'
alias l='bun run lint'
alias lf='bun run lint:fix'