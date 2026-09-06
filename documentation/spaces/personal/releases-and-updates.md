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

Personal Space automatically checks the public master release branch for newer versions, shows release notes, provides the supported updater command, and displays a blocking progress handoff while local services rebuild.

## Read the page

Release checks work automatically after installation. No repository fields,
GitHub token, or connection test is required. The dashboard checks the built-in
public `master` source and shows **Update available** when a newer release exists.
Checks use a 15-minute cache, share concurrent requests, and retry temporary errors
with increasing delays. The last successful result remains available while the
connection recovers.

![Release notes modal](../../assets/spaces/personal/release-notes-modal.png)

The top-right release icon opens versioned release cards with component versions and user-facing changes. After a successful update, the dashboard can reopen the notes for the installed version automatically.

![Update progress handoff](../../assets/spaces/personal/update-progress.png)

During an update, the dashboard displays the target version, current phase, timestamp, and progress percentage. Once the update source has been fetched, the displayed version is read from that fetched branch rather than from the release currently running on the machine. This handoff remains blocking while services are being rebuilt and the dashboard is not ready for normal use. An already-open dashboard switches to the handoff as soon as an update starts. If the browser is closed, the update continues safely and the next dashboard visit opens the completed release notes.

Long migration phases can also publish a read-only progress observation below the overall percentage. For example, Graph V2 rebuild reports completed, total, and remaining memories approximately once per minute. This is detail about the current phase, not a second completion bar; a failed observation does not interrupt the update or change the migration result.

## Actions

1. When the bottom notification says **Update available**, select **Details**.
2. Review current and latest versions, release notes, and any MCP restart warning.
3. Copy the displayed update command and run it from the repository in a terminal. For public releases, it is `npm run update-persistent-memory -- --branch master`, which explicitly selects the public release branch. Opening Details does not start the update.
4. Keep the dashboard open while the progress handoff reports the rebuild. The page reloads when the updated dashboard is ready.
5. Read the release notes after reload. Restart Codex or Claude when the release explicitly says MCP changes require it.

## Update compatibility

Version 1.0.0 establishes the public release baseline. Later releases declare
supported upgrade paths in their release contract. Automatic checks accept only
the public release line, so earlier development version numbers are not offered
as updates. Install updates using the command shown in the dashboard.

## States

| State | Meaning |
| --- | --- |
| Up to date | The public master branch has no newer release for this installation. |
| Update available | A newer public master release was detected; Details is available. |
| Details open | The dashboard shows versions, notes, branch context, and the terminal update command. |
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
| Details opens but nothing updates | This is expected until you run the displayed command in a terminal. |
| Progress appears stalled | Keep the terminal and dashboard open, read the current phase and error, and wait for long rebuild steps before retrying. |
| Dashboard reloads but MCP tools are stale | Follow the release warning and restart Codex or Claude so MCP schemas reload. |
| Release history cannot load | Reopen the release icon after the dashboard is healthy; a transient dashboard or asset error can prevent the modal from loading. |
