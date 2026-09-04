---
nav_title: Docs System
nav_group: stack-layers
nav_group_title: Stack Layers
nav_group_order: 40
nav_order: 100
---
# Docs System Layer

Source: `layers/docs-system/`

Owns the documentation system: the native dashboard guide, MkDocs configuration,
the versioned Node runtime, generated-docs policy, and diagram support. The
dedicated `documentation` image builds committed Markdown and serves the stack
manual internally; authenticated dashboard route handlers proxy `/docs/*`.
`/documentation` renders space-aware help for dashboard pages and tools and
opens the stack manual separately. Generated HTML remains gitignored and is
never committed.

Mermaid fences use the Material SuperFences integration plus the pinned
`apps/documentation/package.json` Mermaid dependency and
`documentation/javascripts/mermaid.mjs` initializer. Local and Docker builds copy
the locked Mermaid browser bundle into the generated site; the initializer
exposes that same-origin runtime through `window.mermaid`, allowing Material's
own navigation lifecycle to render diagrams after direct loads and in-site
navigation without fetching executable code from a third-party CDN. Each
rendered diagram opens in a modal viewer with mouse-wheel zoom, pointer panning,
keyboard controls, reset, and close actions.

## Related documentation

- [Documentation Release History](../release-history.md)
- [Architecture](../stack-architecture/architecture.md)
- [Operations](../stack-architecture/operations.md)
