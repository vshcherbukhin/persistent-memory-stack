---
title: Notifications
description: Configure browser notifications for Personal Space events.
icon: notifications
dashboard_space: local-personal
nav_title: Notifications
nav_group: spaces
nav_group_title: Spaces
nav_group_order: 20
nav_section: personal
nav_section_title: Personal Space Documentation
nav_section_order: 10
nav_order: 90
---

# Notifications

## Purpose

Notifications controls local Chrome or browser notifications for selected dashboard events. Public application release checks run automatically and require no source settings.

## Read the page

System notifications contains a master browser-notification checkbox followed by event types: memory added, memory updated, memory removed, and security alerts.

The event checkboxes are unavailable until browser notifications are enabled. **Save** becomes available only after a preference changes.

## Actions

1. Open **System notifications**.
2. Enable Chrome or browser notifications. Approve the browser permission prompt when it appears.
3. Select only the event types you want.
4. Choose **Save** to register the current preferences.

Personal Notifications has no test-send control. Saving preferences does not produce a sample notification.

## States

| State | Meaning |
| --- | --- |
| Browser notifications off | Event types are locked and no local browser alerts are requested. |
| Browser permission pending | The browser has not yet granted notification access. |
| Browser notifications on | Selected event types can create browser notifications. |
| Save disabled | Nothing changed or a save is in progress. |

## Cautions

> **Caution**
>
> Browser permission is controlled by the browser as well as the dashboard. Enabling the dashboard checkbox cannot override a browser-level block.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Notifications never appear | Confirm the master checkbox is saved, the event type is selected, and the browser grants notifications for this dashboard. |
| Save is disabled | Change a browser-notification preference first. |
| You cannot find Test notification | Personal Space intentionally has no test-send action. Wait for a real selected event. |
