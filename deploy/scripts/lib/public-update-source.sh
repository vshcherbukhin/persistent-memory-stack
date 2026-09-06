#!/usr/bin/env bash
# Native Node reads the shared public source manifest on every supported host.
# Requires host-platform.sh; sourcing this file performs no IO.
pm_assert_public_update_origin() {
    local repo_root
    repo_root="$(pm_host_path "$1")"
    node "$repo_root/scripts/public-update-source.mjs" check "$repo_root"
}

pm_git_fetch_origin_branch() {
    # Operator branches retain this checkout's normal Git transport.
    GIT_TERMINAL_PROMPT=0 git fetch --quiet --no-recurse-submodules origin "$1"
}
