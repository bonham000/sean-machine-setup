#!/bin/bash
#
# Check all repos: run bun install + tsc -build in each, report one-liner per repo.
# Runs each repo in parallel for speed.
#
# Usage:
#   ./check-repos.sh
#   check  (via alias)

REPOS_DIR="$HOME/Documents"
# Keep this list in sync with REPOS in sync-repos.sh and pull-repos.sh
REPOS=(
    "core-repo"
    "second-language-monorepo"
    "daybreak-monorepo"
    "consumer-ninja-monorepo"
    "stories-monorepo"
    "sl-content-hub"
    "language-hubs"
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
    if [ ! -d "$repo_path" ]; then
        echo "missing" > "$result_file"
        return
    fi

    cd "$repo_path" || { echo "missing" > "$result_file"; return; }

    # bun install
    local install_output
    install_output=$(bun install 2>&1)
    local install_exit=$?

    if [ $install_exit -ne 0 ]; then
        echo "install-failed" > "$result_file"
        echo "$install_output" > "${result_file}.log"
        return
    fi

    # tsc
    local tsc_output
    tsc_output=$(bun run tsc 2>&1)
    local tsc_exit=$?

    if [ $tsc_exit -ne 0 ]; then
        local error_count
        error_count=$(echo "$tsc_output" | grep -c "^.\+([0-9]\+,[0-9]\+): error TS")
        echo "tsc-failed" > "$result_file"
        echo "$error_count" > "${result_file}.count"
        echo "$tsc_output" > "${result_file}.log"
        return
    fi

    echo "ok" > "$result_file"
}

main() {
    # Print repo list
    echo -e "${BOLD}${CYAN}Running checks in:${RESET}"
    for repo in "${REPOS[@]}"; do
        echo -e "  ${CYAN}-${RESET} ${repo}"
    done
    echo ""

    echo -e "${BOLD}${CYAN}Steps: bun install → bun run tsc${RESET}"
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
    echo -e "${BOLD}Status:${RESET}"
    echo ""

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
            ok)
                echo -e "  ${GREEN}✓${RESET}  ${padded}  ${GREEN}ok${RESET}" ;;
            install-failed)
                echo -e "  ${RED}✗${RESET}  ${padded}  ${RED}bun install failed${RESET}" ;;
            tsc-failed)
                local count="?"
                [ -f "${result_file}.count" ] && count=$(cat "${result_file}.count")
                echo -e "  ${RED}✗${RESET}  ${padded}  ${RED}tsc — ${count} error(s)${RESET}" ;;
            missing)
                echo -e "  ${YELLOW}-${RESET}  ${padded}  ${YELLOW}repo not found${RESET}" ;;
            *)
                echo -e "  ${RED}?${RESET}  ${padded}  ${RED}${status}${RESET}" ;;
        esac
    done

    # Summary
    echo ""
    echo -e "${BOLD}Ran per repo:${RESET}"
    echo -e "  1. ${CYAN}bun install${RESET}"
    echo -e "  2. ${CYAN}bun run tsc${RESET}"
    echo ""
}

main
