---
title: Shared Space Documentation
description: Current availability of the local Shared Space client and dashboard.
icon: cloud_sync
dashboard_space: local-shared-client
nav_title: In development
nav_group: spaces
nav_group_title: Spaces
nav_group_order: 20
nav_section: shared
nav_section_title: Shared Space Documentation
nav_section_order: 20
nav_order: 10
---
# Shared Space Documentation

**Status: In development.**

The local Shared Space client and dashboard are in development. Shared setup and
testing are deferred, and Personal Space remains the supported local workflow.

Use [Personal Space Documentation](../personal/index.md) for the currently
supported local dashboard experience.

When a Shared connection is explicitly configured, its Memories page uses the
same List / Memory Graph / Tools structure. Graph snapshot, facet, and activity
requests go through the saved remote connector token on the dashboard server;
the browser never receives that token or a raw graph partition id. Own and
mounted nodes remain visibly distinct, and the remote API derives every readable
surface/team/project partition from that connection's identity.
