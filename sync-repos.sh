#!/bin/bash
#
# Sync all repos: push any unpushed commits. Runs each repo in parallel for speed.
#
# Usage:
#   ./sync-repos.sh
#   sync  (via alias)

REPOS_DIR="$HOME/Documents"
# Keep this list in sync with REPOS in pull-repos.sh, status-repos.sh, check-repos.sh and repo-menu.py
REPOS=(
    "core-repo"
    "second-language-monorepo"
    "daybreak-monorepo"
    "priori-tools-monorepo"
    "stories-monorepo"
    "sl-content-hub"
    "language-hubs"
    "side-hustle-monorepo"
    "life-monorepo"
    "abacus-monorepo"
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

    # Check repo exists
    if [ ! -d "$repo_path/.git" ]; then
        echo "missing" > "$result_file"
        return
    fi

    cd "$repo_path" || { echo "missing" > "$result_file"; return; }

    # Check for uncommitted changes (staged, unstaged, or untracked)
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
        echo "dirty" > "$result_file"
        return
    fi

    # Check for unpushed commits
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -z "$branch" ]; then
        echo "no-branch" > "$result_file"
        return
    fi

    local upstream
    upstream=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
    if [ -z "$upstream" ]; then
        # No upstream tracking branch — check if there are any commits at all
        echo "no-upstream" > "$result_file"
        return
    fi

    local ahead
    ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null)
    if [ "$ahead" -eq 0 ] 2>/dev/null; then
        echo "synced" > "$result_file"
        return
    fi

    # Has unpushed commits — push
    local push_output
    push_output=$(git push 2>&1)
    local push_exit=$?

    if [ $push_exit -ne 0 ]; then
        echo "push-failed" > "$result_file"
        echo "$push_output" > "${result_file}.log"
        return
    fi

    echo "pushed" > "$result_file"
}

main() {
    echo -e "${BOLD}${CYAN}Syncing repos...${RESET}"
    echo ""

    # Create temp dir for results
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" EXIT

    # Launch all repos in parallel
    local pids=()
    for repo in "${REPOS[@]}"; do
        process_repo "$repo" "$tmp_dir/$repo" &
        pids+=($!)
    done

    # Wait for all to finish
    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    # Print results
    local max_len=0
    for repo in "${REPOS[@]}"; do
        [ ${#repo} -gt $max_len ] && max_len=${#repo}
    done

    for repo in "${REPOS[@]}"; do
        local result_file="$tmp_dir/$repo"
        local status="unknown"
        [ -f "$result_file" ] && status=$(cat "$result_file")

        local padded
        padded=$(printf "%-${max_len}s" "$repo")

        case "$status" in
            synced)
                echo -e "  ${GREEN}✓${RESET}  ${padded}  ${GREEN}synced with origin${RESET}" ;;
            pushed)
                echo -e "  ${GREEN}↑${RESET}  ${padded}  ${GREEN}pushed to origin${RESET}" ;;
            dirty)
                echo -e "  ${YELLOW}●${RESET}  ${padded}  ${YELLOW}has uncommitted changes${RESET}" ;;
            push-failed)
                echo -e "  ${RED}✗${RESET}  ${padded}  ${RED}git push failed${RESET}" ;;
            no-upstream)
                echo -e "  ${YELLOW}?${RESET}  ${padded}  ${YELLOW}no upstream tracking branch${RESET}" ;;
            missing)
                echo -e "  ${RED}-${RESET}  ${padded}  ${RED}repo not found${RESET}" ;;
            *)
                echo -e "  ${RED}?${RESET}  ${padded}  ${RED}${status}${RESET}" ;;
        esac
    done

    echo ""
}

main
