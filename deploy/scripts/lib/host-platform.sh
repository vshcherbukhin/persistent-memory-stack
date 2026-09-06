#!/usr/bin/env bash
# Keep host filesystem paths usable by both Git Bash and native Windows Node /
# Docker. Never convert container paths (for example /snapshot or /var/run).

pm_is_windows_shell() {
    case "$(uname -s)" in MINGW*|MSYS*) return 0 ;; *) return 1 ;; esac
}

pm_host_path() {
    if pm_is_windows_shell; then
        cygpath -am -- "$1"
    else
        printf '%s\n' "$1"
    fi
}

pm_host_pwd() {
    pm_host_path "$PWD"
}

if pm_is_windows_shell; then
    # Docker arguments contain Linux paths and URLs. All host paths are
    # normalized explicitly instead of relying on MSYS heuristics.
    export MSYS_NO_PATHCONV=1
    export MSYS2_ARG_CONV_EXCL='*'
fi
