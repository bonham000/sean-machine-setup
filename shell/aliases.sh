# Interactive aliases shared by Bash and Zsh.
# Keep every sourced alias definition in this file so duplicates are visible.

# Navigation
alias ll='ls -alF'
alias la='ls -A'
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias home='cd ~'
alias root='cd /'
alias desk='cd ~/Desktop'
alias docs='cd ~/Documents'
alias downs='cd ~/Downloads'
alias work='cd /workspace'

# Git
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
alias gtc='git add . && gt cc -m'
alias gta='git add . && gt create -m'
alias cont='git add . && gt continue'

# JavaScript and project checks
alias y='yarn'
alias b='bun'
alias p='pnpm'
alias n='npm'
alias bi='bun install'
alias c='task check'
alias r='task check:release'
alias bc='bun run check'
alias ts='bun run tsc'
alias l='bun run lint'
alias lf='bun run lint:fix'
alias bt='bun test'
alias d='task dev'

# Project-specific helpers
alias hc='cd packages/server/hasura-project && hasura console'
alias f='yarn start-frontend'
alias fs='yarn fix-server'
alias swc='yarn server swc'
alias rl='yarn frontend relay'
alias gty='yarn server gen-types'
alias rev='gtc "Address code review comments"'
alias shipyard='ssh-add --apple-use-keychain ~/.ssh/shipyard_ed25519'

# Python
alias py='python'
alias py3='python3'
alias pip='pip3'
alias venv='python -m venv'
alias activate='source venv/bin/activate'

# Docker
alias dc='docker-compose'
alias dps='docker ps'
alias di='docker images'

# Editors and shell
alias v='vim'
alias vi='vim'
alias code='code .'
alias x='code-insiders .'
alias z='zed .'
alias s='"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" .'
alias ta='tmux attach'
alias reload='source "${ZDOTDIR:-$HOME}/.zshrc"'
alias zshconfig='vim "${ZDOTDIR:-$HOME}/.zshrc"'
alias ohmyzsh='vim ~/.oh-my-zsh'

# Interactive tools
# tm is a function in shell/functions.sh so it can insert the command at the prompt.
alias rn='"$SEAN_MACHINE_SETUP_ROOT/package-menu.zsh"'
alias jf='"$SEAN_MACHINE_SETUP_ROOT/package-menu.zsh"'
alias tmx='"$SEAN_MACHINE_SETUP_ROOT/tmux-menu.zsh"'
alias ff='"$SEAN_MACHINE_SETUP_ROOT/commit-menu.zsh"'
alias a='agent-tui'
alias an='agent-tui new'

# Workstreams and repo family
alias w='task ws'
alias ww='task ws -- --active-only'
alias wsm='task wsm'
alias wa='task -d "$HOME/Documents/core-repo" ws:all'
alias sync='task -d "$HOME/Documents/core-repo" repos:sync -- --all'
alias pull='task -d "$HOME/Documents/core-repo" repos:pull -- --all'
alias rebase='task -d "$HOME/Documents/core-repo" repos:rebase -- --all'
alias st='task -d "$HOME/Documents/core-repo" repos:status'

# System information and utilities
alias mkdir='mkdir -pv'
alias df='df -H'
alias du='du -ch'
alias free='free -m'
alias top='htop || top'
alias ports='netstat -tulanp'
alias listen='lsof -i -P | grep LISTEN'
alias ping='ping -c 5'
alias meminfo='free -m -l -t'
alias psmem='ps auxf | sort -nr -k 4 | head -10'
alias pscpu='ps auxf | sort -nr -k 3 | head -10'
alias cpuinfo='lscpu'
alias serve='python -m http.server 8000'
alias json='python -m json.tool'
alias timestamp='date +%s'
alias uuid='uuidgen | tr "[:upper:]" "[:lower:]"'

# Explicit cleanup commands
alias clean-ds='find . -type f -name "*.DS_Store" -ls -delete'
alias clean-pyc='find . -type f -name "*.pyc" -exec rm -f {} +'
alias clean-npm='rm -rf node_modules package-lock.json && npm install'
alias clean-docker='docker system prune -af'
