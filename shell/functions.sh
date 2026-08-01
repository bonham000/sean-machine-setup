# Small interactive functions shared by Bash and Zsh.
# Larger interactive tools belong in the repository's executable *.zsh files.

# Ensure we can define `tm` when third-party aliases (for example, zsh plugins)
# define the same name.
unalias tm 2>/dev/null || true

dd() {
    local selected_command

    if [ -z "${ZSH_VERSION:-}" ]; then
        printf '%s\n' 'dd requires zsh so it can place the selected command at the prompt.' >&2
        return 1
    fi

    selected_command="$(source "$SEAN_MACHINE_SETUP_ROOT/dev-task-menu.zsh")" || return
    [ -n "$selected_command" ] && print -z -- "$selected_command"
}

tm() {
    local selected_command

    if [ -z "${ZSH_VERSION:-}" ]; then
        printf '%s\n' 'tm requires zsh so it can place the selected command at the prompt.' >&2
        return 1
    fi

    selected_command="$(source "$SEAN_MACHINE_SETUP_ROOT/task-menu.zsh")" || return
    [ -n "$selected_command" ] && print -z -- "$selected_command"
}

cj() {
    local selected_directory

    if [ -n "${ZSH_VERSION:-}" ]; then
        selected_directory="$(source "$SEAN_MACHINE_SETUP_ROOT/repo-menu.zsh")"
    else
        selected_directory="$("$SEAN_MACHINE_SETUP_ROOT/repo-menu.zsh")"
    fi

    [ -n "$selected_directory" ] && cd "$selected_directory"
}

# Local AI commit command using OpenRouter.
cm() {
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        printf '%s\n' 'Not in a git repository.' >&2
        return 1
    fi

    local ai_commit_api_key="${AI_COMMIT_OPENROUTER_API_KEY:-${OPENROUTER_API_KEY:-}}"
    local ai_commit_model="${AI_COMMIT_OPENROUTER_MODEL:-google/gemini-2.5-flash}"
    local ai_commit_diff ai_commit_response

    if [ -z "$ai_commit_api_key" ]; then
        printf '%s\n' 'Set AI_COMMIT_OPENROUTER_API_KEY or OPENROUTER_API_KEY first.' >&2
        return 1
    fi

    git add .
    if git diff --cached --quiet; then
        printf '%s\n' 'No changes staged.' >&2
        return 1
    fi

    git status --short
    ai_commit_diff=$(git diff --cached --diff-filter=AMR |
        grep -v 'package-lock.json\|yarn.lock\|pnpm-lock.yaml\|bun.lockb\|poetry.lock\|Pipfile.lock\|\.min\.js\|\.min\.css' |
        head -n 500)

    ai_commit_response=$(printf '%s' "$ai_commit_diff" |
        AI_COMMIT_API_KEY="$ai_commit_api_key" python3 -c "
import json, os, sys, urllib.request

diff = sys.stdin.read()
data = {
    'model': '$ai_commit_model',
    'messages': [
        {'role': 'system', 'content': 'Write a concise git commit message using conventional commit format (feat/fix/refactor/docs/test/chore). Be technical and specific.'},
        {'role': 'user', 'content': f'Generate a commit message for this diff:\\n\\n{diff}'},
    ],
    'max_tokens': 150,
    'temperature': 0.7,
}
request = urllib.request.Request(
    'https://openrouter.ai/api/v1/chat/completions',
    data=json.dumps(data).encode('utf-8'),
    headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {os.environ[\"AI_COMMIT_API_KEY\"]}',
    },
)
with urllib.request.urlopen(request) as response:
    result = json.loads(response.read())
    print(result['choices'][0]['message']['content'].strip().strip(chr(96)))
" 2>&1) || {
        printf 'Commit message generation failed:\n%s\n' "$ai_commit_response" >&2
        return 1
    }

    printf '\n%s\n\n' "$ai_commit_response"
    git commit -m "$ai_commit_response"
}

rp() {
    rg -g '!{**/node_modules/*,**/.git/*,**/dist/*,**/public/*,**/build/*}' -F "$@"
}

mkcd() {
    mkdir -p "$1" && cd "$1"
}

extract() {
    if [ ! -f "$1" ]; then
        printf "'%s' is not a valid file\n" "$1" >&2
        return 1
    fi

    case "$1" in
        *.tar.bz2) tar xjf "$1" ;;
        *.tar.gz) tar xzf "$1" ;;
        *.bz2) bunzip2 "$1" ;;
        *.rar) unrar e "$1" ;;
        *.gz) gunzip "$1" ;;
        *.tar) tar xf "$1" ;;
        *.tbz2) tar xjf "$1" ;;
        *.tgz) tar xzf "$1" ;;
        *.zip) unzip "$1" ;;
        *.Z) uncompress "$1" ;;
        *.7z) 7z x "$1" ;;
        *) printf "'%s' cannot be extracted via extract()\n" "$1" >&2; return 1 ;;
    esac
}

git-cleanup() {
    git branch --merged | grep -v '\*\|main\|master\|development' | xargs -n 1 git branch -d
}

find-replace() {
    if [ "$#" -ne 2 ]; then
        printf '%s\n' "Usage: find-replace 'search' 'replace'" >&2
        return 1
    fi
    rg -l "$1" | xargs sed -i "s/$1/$2/g"
}

path() {
    printf '%s\n' "$PATH" | tr ':' '\n'
}

backup() {
    cp "$1" "$1.backup.$(date +%Y%m%d_%H%M%S)"
}

mkvenv() {
    local environment_name="${1:-venv}"
    python -m venv "$environment_name" && source "$environment_name/bin/activate"
}

qgc() {
    git add -A && git commit -m "$*"
}

gpc() {
    git push origin "$(git branch --show-current)"
}

hist() {
    history | grep "$1"
}

killp() {
    ps aux | grep -v grep | grep "$1" | awk '{print $2}' | xargs kill -9
}

duh() {
    du -sh ./* | sort -rh | head -20
}

tmpd() {
    local temporary_directory
    temporary_directory=$(mktemp -d) && cd "$temporary_directory"
}

most-used() {
    history | awk '{print $2}' | sort | uniq -c | sort -rn | head -20
}

dsh() {
    docker exec -it "$1" /bin/bash || docker exec -it "$1" /bin/sh
}

gitlog() {
    local entry_count="${1:-20}"
    git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset' --abbrev-commit -n "$entry_count"
}
