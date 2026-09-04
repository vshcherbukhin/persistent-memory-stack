# Docs System

## Owns
- Capability: MkDocs structure, dashboard docs, diagrams, and committed documentation.
- Runtime touchpoints: docs build and published documentation navigation.
- Dashboard touchpoints: documentation references surfaced in the product.
- Data stores: markdown docs and doc site source files.
- MkDocs config: `mkdocs.yml`.
- Python docs dependencies: `documentation/requirements.txt`.
- Generated output: `.local/generated-docs/site` (gitignored).
- Dashboard guide: `apps/dashboard/src/app/(dashboard)/documentation/page.tsx`
  renders native, space-aware visual help from the canonical Markdown in
  `documentation/spaces/` through
  `apps/dashboard/src/lib/dashboardDocumentation.ts`, and opens the separate
  stack manual at `/docs/index.html`.
- Guide media: privacy-safe PNG captures live under
  `documentation/assets/spaces/`; both the native reader and MkDocs use the
  same files. The screenshot redaction policy is maintained in
  `apps/documentation/README.md`.
- Runtime integration: `apps/documentation/Dockerfile` builds committed Markdown;
  its Node service serves the output internally on port 8000. Authenticated
  dashboard route handlers proxy `/docs/*` to that service. Generated HTML
  remains uncommitted.
- Diagram runtime: `apps/documentation/package.json` pins Mermaid 11. Local and
  Docker builds copy its browser bundle into the generated site, while
  `documentation/javascripts/mermaid.mjs` exposes that local runtime through
  `window.mermaid` for Material's navigation lifecycle. Rendered diagrams open
  in a keyboard-accessible pan/zoom viewer. No diagram code is fetched from a
  third-party CDN at runtime.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shells owned by `apps/`.

## Verification
- Layer checks live under `test/layers/docs-system/`.
- Dashboard image integration checks live in
  `apps/dashboard/src/lib/docs-system.test.ts`.
- Runtime, Compose, navigation, and phase-label checks live in
  `apps/documentation/test/documentation.test.mjs`.
- Run `npm run docs:install` once to install Python and locked JavaScript docs
  dependencies, then `npm run docs:build`.
