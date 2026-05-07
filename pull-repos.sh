#!/bin/bash
#
# Pull all repos: skip repos with local changes/commits, pull origin for clean ones.
# Runs each repo in parallel, prints status as each completes.
#
# Usage:
#   ./pull-repos.sh
#   pull  (via alias)

REPOS_DIR="$HOME/Documents"
# Keep this list in sync with REPOS in sync-repos.sh, status-repos.sh, check-repos.sh and repo-menu.py
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
    "super-claude"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# Padding — compute once in main, pass as arg
process_repo() {
    local repo="$1"
    local repo_path="$REPOS_DIR/$repo"
    local result_file="$2"
    local max_len="$3"

    local padded
    padded=$(printf "%-${max_len}s" "$repo")

    # Check repo exists
    if [ ! -d "$repo_path/.git" ]; then
        echo -e "  ${RED}-${RESET}  ${padded}  ${RED}repo not found${RESET}"
        echo "missing" > "$result_file"
        return
    fi

    cd "$repo_path" || { echo "missing" > "$result_file"; return; }

    # Check for uncommitted changes
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
        echo -e "  ${YELLOW}●${RESET}  ${padded}  ${YELLOW}skipped — has local changes${RESET}"
        echo "dirty" > "$result_file"
        return
    fi

    # Check for unpushed commits
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ -z "$branch" ]; then
        echo -e "  ${RED}?${RESET}  ${padded}  ${RED}no branch${RESET}"
        echo "no-branch" > "$result_file"
        return
    fi

    local upstream
    upstream=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
    if [ -z "$upstream" ]; then
        echo -e "  ${YELLOW}?${RESET}  ${padded}  ${YELLOW}no upstream tracking branch${RESET}"
        echo "no-upstream" > "$result_file"
        return
    fi

    local ahead
    ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null)
    if [ "$ahead" -gt 0 ] 2>/dev/null; then
        echo -e "  ${YELLOW}↑${RESET}  ${padded}  ${YELLOW}skipped — ${ahead} unpushed commit(s)${RESET}"
        echo "unpushed" > "$result_file"
        return
    fi

    # Clean and up-to-date locally — pull
    local pull_output
    pull_output=$(git pull 2>&1)
    local pull_exit=$?

    if [ $pull_exit -ne 0 ]; then
        echo -e "  ${RED}✗${RESET}  ${padded}  ${RED}pull failed${RESET}"
        echo "pull-failed" > "$result_file"
        return
    fi

    # Check if pull actually brought in new commits
    if echo "$pull_output" | grep -q "Already up to date"; then
        echo -e "  ${GREEN}✓${RESET}  ${padded}  ${GREEN}already up to date${RESET}"
        echo "up-to-date" > "$result_file"
    else
        echo -e "  ${GREEN}↓${RESET}  ${padded}  ${GREEN}pulled from origin${RESET}"
        echo "pulled" > "$result_file"
    fi
}

main() {
    echo -e "${BOLD}${CYAN}Pulling repos...${RESET}"
    echo ""

    # Create temp dir for results
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" EXIT

    # Compute max repo name length for alignment
    local max_len=0
    for repo in "${REPOS[@]}"; do
        [ ${#repo} -gt $max_len ] && max_len=${#repo}
    done

    # Launch all repos in parallel
    local pids=()
    for repo in "${REPOS[@]}"; do
        process_repo "$repo" "$tmp_dir/$repo" "$max_len" &
        pids+=($!)
    done

    # Wait for all to finish
    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    echo ""
}

main
