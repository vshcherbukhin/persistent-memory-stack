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

## Memory activity indicators

The strip below the top panel shows **stream mcp**, **memory read**, **memory write**,
and **memory update**, in that order. Stream MCP describes service availability;
the other indicators describe authenticated memory requests for your personal identity.
They show no memory content, queries, credentials, or client messages.

| Activity state | Meaning |
| --- | --- |
| idle | No request is active and no completion remains in the recent window. |
| reading / writing / updating | A request is in progress; a number indicates overlapping requests of that kind. |
| done | A request completed successfully in the last 8 seconds. Saving is separate from embedding and graph processing. |
| error | A request failed in the last 8 seconds; inspect the operation's own result for details. |
| starting | The embedding dependency is starting. The request has not succeeded; wait for readiness before retrying. |
| unavailable | A current activity observation could not be obtained. This does not mean a request succeeded or failed. |

Activity refreshes about once per second while the page is visible. Recent completion
states clear after 8 seconds; they are transient feedback, not an audit history.

## Live MCP activity

The lower row shows what is connected right now and where memory is accumulating.

Live MCP activity lists the stream sessions the MCP service is holding at this moment.

| Column | How to read it |
| --- | --- |
| Client | The connected agent application, with its session identifier below |
| Connection | The transport the session uses, normally streamable-http |
| Last seen | How long ago the MCP service last heard from that session |
| Terminates at | Time left before an idle session closes, and the clock time it closes |

Select a session to read its live communication inside the same card, then select **All sessions** to return to the list. A session leaves the list as soon as its connection closes, and the card returns to the list if the session you are watching disconnects. An agent that stops without closing its session stays listed until its idle timeout, which you set in System Settings.

Corpus shape, beside it, ranks the categories your saved memories fall into.

## Actions

1. Select any **Open details** link to open its exact destination.
2. Use the MCP card to open the **MCP sessions** tab in Services, not the application-service list.
3. Use **Open settings** on Fact extraction or Embeddings to open that exact System Settings section.
4. Select a session in **Live MCP activity** to watch its requests, and **All sessions** to go back.
5. Investigate error or attention badges before making unrelated configuration changes.

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
| Live MCP activity shows no sessions | No agent is connected. Start Claude or Codex, or confirm the stream MCP registration in Services. |
| Live sessions are unavailable | The Docker control sidecar is not answering. Open Services and read its notice. |
| A session shows no output yet | The session has not sent a request since it connected. Its output appears with the next call. |
