#!/usr/bin/env bash

# Produces the absolute state directory shared by the updater and the dashboard
# gateway. Keeping this independent of a release worktree means the stable
# dashboard URL continues to see the same handoff event throughout an update.
pm_normalize_handoff_state_dir() {
    local source_root configured_dir
    source_root="$1"
    configured_dir="${2:-$source_root/.local/update-state}"
    case "$configured_dir" in
        /*|[A-Za-z]:[\\/]*) printf '%s\n' "${configured_dir//\\//}" ;;
        *) printf '%s/%s\n' "$source_root" "$configured_dir" ;;
    esac
}
