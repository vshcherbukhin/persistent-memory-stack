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

pm_resolve_published_release() {
    local repo_root
    repo_root="$(pm_host_path "$1")"
    if [ -n "${2:-}" ]; then
        node "$repo_root/scripts/github-releases.mjs" --version "$2"
    else
        node "$repo_root/scripts/github-releases.mjs"
    fi
}

pm_git_fetch_published_tag() {
    # Fetch only the API-selected tag, without changing local tags. Never trust
    # a stale cached branch or FETCH_HEAD after a failed request.
    node - "$1" "$2" "$3" <<'NODE'
const { execFileSync } = require('node:child_process');
const [repo, tag, expected] = process.argv.slice(2);
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)
    || !/^[0-9a-f]{40}$/.test(expected)) throw new Error('Invalid published release pin.');
const options = { cwd: repo, encoding: 'utf8', timeout: 60000, windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] };
let actual;
try {
  execFileSync('git', ['fetch', '--quiet', '--no-recurse-submodules', '--no-tags', 'origin', `refs/tags/${tag}`], options);
  actual = execFileSync('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], options).trim();
} catch {
  // Git tracing, proxies, and credential helpers can include secrets in diagnostics.
  console.error('Published release Git fetch failed. Check repository access and connectivity, then retry.');
  process.exit(1);
}
if (actual !== expected) throw new Error(`Published tag ${tag} changed while fetching. Refusing to update.`);
process.stdout.write(actual);
NODE
}
