---
title: Releases and updates
description: Read automatic release checks, review update details, start the supported updater, and follow update progress.
icon: new_releases
dashboard_space: local-personal
nav_title: Releases and updates
nav_group: spaces
nav_group_title: Spaces
nav_group_order: 20
nav_section: personal
nav_section_title: Personal Space Documentation
nav_section_order: 10
nav_order: 120
---

# Releases and updates

## Purpose

Personal Space automatically checks published stable GitHub Releases for newer versions, shows release notes, provides the supported updater command, and displays a blocking progress handoff while local services rebuild.

## Read the page

Release checks work automatically after installation. No repository fields,
GitHub token, or connection test is required. The dashboard checks the built-in
public repository's latest stable GitHub Release and shows **Update available**
when its version is newer than the installed version. GitHub's designated latest
release is used; checks do not sort every tag by version. Drafts, prereleases,
and unpublished commits on `master` are not offered as updates. The tag, package
version, public release line and release notes must agree at the exact tagged
commit. The updater validates that commit's upgrade compatibility contract
before installation.
Checks use a 15-minute cache, share concurrent requests, and retry temporary errors
with increasing delays. The last successful result remains available while the
connection recovers.

![Release notes modal](../../assets/spaces/personal/release-notes-modal.png)

The top-right release icon opens versioned release cards with component versions,
user-facing changes and a link to that exact version on GitHub Releases. Update
Details also links to the corresponding GitHub Release. After a successful update,
the dashboard can reopen the notes for the installed version automatically.

![Update progress handoff](../../assets/spaces/personal/update-progress.png)

During an update, the dashboard displays the target version, current phase, timestamp, and progress percentage. The displayed target identifies the validated release source being installed, rather than the release currently running on the machine. This handoff remains blocking while services are being rebuilt and the dashboard is not ready for normal use. An already-open dashboard switches to the handoff as soon as an update starts. If the browser is closed, the update continues safely and the next dashboard visit opens the completed release notes.

Long migration phases can also publish a read-only progress observation below the overall percentage. For example, Graph V2 rebuild reports completed, total, and remaining memories approximately once per minute. This is detail about the current phase, not a second completion bar; a failed observation does not interrupt the update or change the migration result.

## Actions

1. When the bottom notification says **Update available**, select **Details**.
2. Review current and latest versions, release notes, and any MCP restart warning.
3. Copy the displayed update command and run it from the repository in a terminal. It uses `npm run update-persistent-memory -- --release <version>` with the displayed release version, so it installs that published release. Opening Details does not start the update.
4. Keep the dashboard open while the progress handoff reports the rebuild. The page reloads when the updated dashboard is ready.
5. Read the release notes after reload. Restart Codex or Claude when the release explicitly says MCP changes require it.

## Update compatibility

Version 1.0.0 establishes the public release baseline. Later releases declare
supported upgrade paths in their release contract. Automatic checks accept only
the public release line, so earlier development version numbers are not offered
as updates. Install updates using the command shown in the dashboard.

Running `npm run update-persistent-memory` without a target selects the latest
published stable release. The updater resolves its tag to a commit and uses that
exact source throughout the update. A missing, unpublished, mismatched or invalid
release fails before installation; it does not fall back to `master`. If an
upgrade needs an intermediate release, that release must also be published and
pass its compatibility checks.

## GitHub Releases, Packages, and Actions

| GitHub feature | What it provides for this project |
| --- | --- |
| Releases | A named version tied to an exact Git tag, with release notes and automatic source ZIP/tar.gz downloads. |
| Packages | A registry for separately built artifacts, such as Docker images in GitHub Container Registry (GHCR) or npm packages. |
| Actions | Automation that can run tests, build artifacts, and publish a release or package when configured. |

The public [GitHub Releases page](https://github.com/vshcherbukhin/persistent-memory-stack/releases)
preserves versioned source snapshots. Version `v1.0.0` identifies the original
public baseline; `v1.1.0` adds resource-aware installation and API embedding choices.
Use the latest stable release for a fresh installation. The repository's
`packages/` directory contains internal source workspaces; its name does not
mean those workspaces are published in GitHub Packages or npm.

These releases distribute source. The installer builds the application images
locally using the existing Dockerfiles. Publishing a GitHub Release alone does
not produce Windows/macOS executables or prebuilt Docker images. The dashboard
uses the GitHub Releases API as its update feed. Merging a version bump to
`master` alone does not make it eligible: a stable GitHub Release must be
published for the matching tag. Installing it remains explicit.

For future prebuilt distribution, GHCR images would fit this Docker application.
That requires builds for Linux `amd64` and `arm64`, versioned image tags and
verified digests, public package visibility, and installer/Compose support for
pulling those images. A GitHub Actions workflow can build and publish them with
repository-scoped permissions after validation. This distribution path is not
included in the source releases. An npm package would instead need a deliberately
packaged CLI/library, a distributable manifest and file list, and registry
configuration; the private monorepo root is not such a package.

See GitHub's [release guide](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
and [container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## States

| State | Meaning |
| --- | --- |
| Up to date | GitHub's latest stable release is not newer than the installed version. |
| Update available | A newer published stable release was detected; Details is available. |
| Details open | The dashboard shows versions, notes, release source, and the terminal update command. |
| Updating | The handoff overlay shows the active rebuild phase and progress. |
| Ready | The updated dashboard reloads and may open the installed release notes. |
| Failed | The handoff or Details view reports an error; do not assume the new version is active. |

## Cautions

> **Caution**
>
> Use the update command shown by the dashboard. The updater snapshots local data before rebuilds, but you should still avoid interrupting the process or closing the terminal while it is active.

Do not treat the version shown in a screenshot as the current release. Always read the live Current version and Latest version values.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| No update-available notification appears | Checks are automatic. Allow the cache or network retry delay to pass; inspect the update-runner log if GitHub remains unreachable. |
| A newer commit or tag exists but no update appears | Only published stable GitHub Releases qualify. A branch commit, bare tag, draft or prerelease is not an automatic update. |
| The requested release cannot be validated | Check that its stable GitHub Release is published and its tag, package version and upgrade contract agree. The updater will not substitute a branch head. |
| Details opens but nothing updates | This is expected until you run the displayed command in a terminal. |
| Progress appears stalled | Keep the terminal and dashboard open, read the current phase and error, and wait for long rebuild steps before retrying. |
| Dashboard reloads but MCP tools are stale | Follow the release warning and restart Codex or Claude so MCP schemas reload. |
| Release history cannot load | Reopen the release icon after the dashboard is healthy; a transient dashboard or asset error can prevent the modal from loading. |
