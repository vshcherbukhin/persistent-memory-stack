---
title: Overview
description: Read Personal Space health, usage, memory, model, and MCP session summaries.
icon: dashboard
dashboard_space: local-personal
nav_title: Overview
nav_group: spaces
nav_group_title: Spaces
nav_group_order: 20
nav_section: personal
nav_section_title: Personal Space Documentation
nav_section_order: 10
nav_order: 30
---

# Overview

![Overview health and activity widgets](../../assets/spaces/personal/overview-widgets.png)

## Purpose

Overview is the fastest way to decide where attention is needed. It summarizes the local services, active MCP sessions, worker schedules, recent token usage, saved memories, fact-extraction model, and embedding pin.

## Read the page

The first row contains clickable summary cards. A large value gives the count or total; the smaller line explains the period or state; the badge gives the health category.

| Card | How to read it |
| --- | --- |
| Services | Active services out of all detected services, plus stopped and failed counts |
| MCP sessions | Active sessions currently managed by the Stream MCP service |
| Workers | Enabled schedules out of all managed jobs, plus stopped and failed counts |
| Token usage | Tokens, requests, and estimated cost from the last 24 hours |
| Saved Memories | Number of personal memory records |
| Fact extraction | Current shape-gate provider and model |
| Embeddings | Current embedding model, vector dimension, mode, and vector name |

Overview refreshes automatically, so there is no manual refresh control.

## Actions

1. Select any **Open details** link to open its exact destination.
2. Use the MCP card to open the **MCP sessions** tab in Services, not the application-service list.
3. Use **Open settings** on Fact extraction or Embeddings to open that exact System Settings section.
4. Investigate error or attention badges before making unrelated configuration changes.

## States

| Badge or value | Meaning |
| --- | --- |
| health | All detected services are active. |
| attention | At least one service or schedule is stopped, or no rows were detected. |
| error | A service failed, Docker control is unavailable, a worker failed, or worker liveness is lost. |
| active | One or more Stream MCP sessions are connected. |
| no active sessions | The Stream MCP service is not reporting a connected client. |
| 24h | The token card is a fixed last-24-hours summary. |

## Cautions

> **Caution**
>
> Overview is a summary, not a control panel. Open the linked page and read its detailed state before stopping services, changing schedules, or editing settings.

The model and usage values may reveal operational metadata. Share screenshots only after checking them for sensitive data.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Services shows Unavailable | Open Services. The Docker control sidecar or its connection may be unavailable. |
| MCP session count is zero | Open **MCP sessions** and confirm the client is connected and has not reached its idle timeout. |
| Worker count shows an error | Open Workers and inspect the failed row's last-run log. |
| A count changed but Overview did not | Wait for automatic refresh, or leave and reopen Overview. |
