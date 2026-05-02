#!/bin/bash
#
# Status of all repos: run git status (purely local, no fetch) in each repo
# in parallel and print a clean one-liner per repo.
#
# Usage:
#   ./status-repos.sh
#   st  (via alias)

REPOS_DIR="$HOME/Documents"
# Keep this list in sync with REPOS in sync-repos.sh, pull-repos.sh, check-repos.sh and repo-menu.py
REPOS=(
    "core-repo"
    "second-language-monorepo"
    "daybreak-monorepo"
    "priori-tools-monorepo"
    "stories-monorepo"
    "sl-content-hub"
    "language-hubs"
    "side-hustle-monorepo"
    "vanlife-monorepo"
    "abacus-monorepo"
    "super-claude"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

process_repo() {
    local repo="$1"
    local repo_path="$REPOS_DIR/$repo"
    local result_file="$2"
    local max_len="$3"

    local padded
    padded=$(printf "%-${max_len}s" "$repo")

    if [ ! -d "$repo_path/.git" ]; then
        echo -e "  ${RED}-${RESET}  ${padded}  ${RED}repo not found${RESET}" > "$result_file"
        return
    fi

    cd "$repo_path" || {
        echo -e "  ${RED}-${RESET}  ${padded}  ${RED}repo not found${RESET}" > "$result_file"
        return
    }

    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -z "$branch" ]; then
        echo -e "  ${RED}?${RESET}  ${padded}  ${RED}no branch${RESET}" > "$result_file"
        return
    fi

    # Counts via porcelain — no network
    local porcelain
    porcelain=$(git status --porcelain 2>/dev/null)

    local unstaged=0 staged=0 untracked=0
    if [ -n "$porcelain" ]; then
        # Status code is the first 2 chars: XY
        # X = staged (index), Y = unstaged (worktree)
        # ?? = untracked
        unstaged=$(echo "$porcelain" | awk 'substr($0,1,2) !~ /^\?\?/ && substr($0,2,1) != " "' | wc -l | tr -d ' ')
        staged=$(echo "$porcelain"   | awk 'substr($0,1,2) !~ /^\?\?/ && substr($0,1,1) != " "' | wc -l | tr -d ' ')
        untracked=$(echo "$porcelain" | awk 'substr($0,1,2) == "??"' | wc -l | tr -d ' ')
    fi

    # Ahead/behind vs upstream — fully local
    local ahead=0 behind=0 upstream
    upstream=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
    local has_upstream=0
    if [ -n "$upstream" ]; then
        has_upstream=1
        local counts
        counts=$(git rev-list --left-right --count "$upstream...HEAD" 2>/dev/null)
        if [ -n "$counts" ]; then
            behind=$(echo "$counts" | awk '{print $1}')
            ahead=$(echo "$counts"  | awk '{print $2}')
        fi
    fi

    # Build status parts
    local parts=()
    [ "$unstaged"  -gt 0 ] && parts+=("${unstaged} unstaged")
    [ "$staged"    -gt 0 ] && parts+=("${staged} staged")
    [ "$untracked" -gt 0 ] && parts+=("${untracked} untracked")
    [ "$ahead"     -gt 0 ] && parts+=("${ahead} unpushed")
    [ "$behind"    -gt 0 ] && parts+=("${behind} behind")

    local dirty=0
    [ "$unstaged" -gt 0 ] || [ "$staged" -gt 0 ] || [ "$untracked" -gt 0 ] && dirty=1

    # Choose glyph + color: dirty > ahead/behind > non-default > clean
    local glyph color
    if [ "$dirty" -eq 1 ]; then
        glyph="●"; color="$YELLOW"
    elif [ "$ahead" -gt 0 ] || [ "$behind" -gt 0 ]; then
        glyph="↑"; color="$YELLOW"
        [ "$behind" -gt 0 ] && [ "$ahead" -eq 0 ] && glyph="↓"
    elif [ "$has_upstream" -eq 0 ]; then
        glyph="?"; color="$YELLOW"
    elif [ "$branch" != "main" ] && [ "$branch" != "master" ]; then
        glyph="◆"; color="$CYAN"
    else
        glyph="✓"; color="$GREEN"
    fi

    # Compose message
    local message
    if [ ${#parts[@]} -eq 0 ]; then
        if [ "$has_upstream" -eq 0 ]; then
            message="no upstream"
        else
            message="in sync"
        fi
    else
        message=$(IFS=', '; echo "${parts[*]}")
    fi

    # Branch suffix when not on default
    local branch_suffix=""
    if [ "$branch" != "main" ] && [ "$branch" != "master" ]; then
        branch_suffix=" ${CYAN}(${branch})${RESET}"
    fi

    echo -e "  ${color}${glyph}${RESET}  ${padded}  ${color}${message}${RESET}${branch_suffix}" > "$result_file"
}

main() {
    echo -e "${BOLD}${CYAN}Repo status...${RESET}"
    echo ""

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" EXIT

    local max_len=0
    for repo in "${REPOS[@]}"; do
        [ ${#repo} -gt $max_len ] && max_len=${#repo}
    done

    local pids=()
    for repo in "${REPOS[@]}"; do
        process_repo "$repo" "$tmp_dir/$repo" "$max_len" &
        pids+=($!)
    done

    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    # Print results in REPOS order (parallel work, deterministic output)
    for repo in "${REPOS[@]}"; do
        local result_file="$tmp_dir/$repo"
        [ -f "$result_file" ] && cat "$result_file"
    done

    echo ""
}

main
