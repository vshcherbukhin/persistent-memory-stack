---
title: Personal Space guide
description: Start here to understand and safely operate the local Personal Memories dashboard.
icon: home
dashboard_space: local-personal
nav_title: Start here
nav_group: spaces
nav_group_title: Spaces
nav_group_order: 20
nav_section: personal
nav_section_title: Personal Space Documentation
nav_section_order: 10
nav_order: 10
---

# Personal Space guide

## Purpose

Personal Space is the dashboard for Persistent Memory Community running on your computer.
One authorized personal knowledge space spans your projects and general conversations. Use it to inspect service health, manage your private memory records, review scheduled work and token usage, respond to security findings, and configure the local stack.

This guide assumes no prior knowledge. Dashboard screenshots use a demonstration profile and synthetic records; your counts, models, and statuses will differ. Examples show both Obsidian and Porcelain themes.

## Read the page

The left sidebar contains the Personal Space pages. The current page is highlighted. The top bar names the page and provides Documentation and Release notes controls. Your profile is at the bottom of the sidebar.

The Overview cards summarize the local stack. Each **Open details** or **Open settings** link goes to the page or setting represented by that card.

| Area | What it is for |
| --- | --- |
| Overview | Health and count summary with direct links |
| Memories | Search, inspect, edit, trust, export, import, and remove records |
| Services | Application service and MCP session status |
| Workers | Scheduled maintenance jobs and their last-run logs |
| Token usage | Token, request, model, service, user, and estimated-cost totals |
| Security | Open DLP and secret-detection findings |
| Notifications | Local browser notification preferences |
| System Settings | Fact extraction, embeddings, retention, and stream session timeout |

## Actions

1. Confirm the sidebar displays **Community edition** beneath the product name.
2. Start on **Overview** and open any card marked error or attention.
3. Use **Memories** for everyday record work.
4. Use **Services** and **Workers** when the stack is unhealthy or background work is delayed.
5. Open **Documentation** in the sidebar or top bar whenever you need the guide for the current dashboard.

## States

| State | Meaning |
| --- | --- |
| Healthy or active | The summarized component is available now. |
| Attention | A service or schedule is stopped, missing, or needs review. |
| Error | A component is unavailable or its most recent operation failed. |
| Empty | The page is working but has no matching records or events. |
| Legacy/unclassified | A preserved older personal record whose new metadata has not been invented. |

## Cautions

> **Caution**
>
> Personal memories and local configuration are real data. Read the caution on an action before deleting records, changing an embedding pin, stopping a service, or changing a worker schedule.

Do not enter secrets into search boxes or documentation. Fields intended for credentials mask or treat their values as write-only where possible.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| A page is missing from the sidebar | Some control pages require local administrator access. Sign in with the account configured for this local dashboard. |
| Counts look stale | Wait for the page's automatic refresh, then reopen the page. Overview, Services, and Workers do not provide manual Refresh buttons. |
| An old Shared Space link fails | Sharing is retired. Open the current personal dashboard from the sidebar. |
| The whole dashboard is unreachable | Check the local stack outside the dashboard before changing any data or configuration. |
