# persistent-memory-documentation

The versioned documentation runtime for PM Management. MkDocs Material builds
the committed Markdown under `documentation/`; this app serves the generated
site with a dependency-free Node HTTP server.

## Runtime

- Compose service: `documentation`
- Image/container: `persistent-memory-documentation`
- Internal port: `8000`
- Health: `GET /health`
- Dashboard URL: `http://localhost:3200/docs/index.html`
- Native dashboard guide: `http://localhost:3200/documentation?space=personal`

The service is internal-only. Dashboard route handlers proxy `/docs/*` so server
deployments keep documentation behind normal dashboard authentication.
The native dashboard guide is owned by `apps/dashboard`; it links here as the
separate stack and architecture manual.

## Local commands

```bash
npm run docs:install
npm run docs:build
npm run docs:serve
npm run test:documentation
```

`docs:serve` checks whether the Compose `documentation` service is running and
the dashboard URL is reachable. If both checks pass, the launcher opens that
URL without starting another process. Otherwise it builds the static site,
starts the local Node server on
`http://127.0.0.1:8000`, and opens that fallback URL.

The service version lives in `apps/documentation/package.json`. User-visible
documentation changes are recorded newest-first in
`documentation/release-history.md` and displayed beside the MkDocs search field.

## Mermaid diagram fallbacks

Mermaid blocks in `documentation/**/*.md` are the canonical diagram source. Run
the following after adding or changing one:

```bash
npm run docs:diagrams
npm run docs:check-diagrams
```

The first command regenerates the committed SVG fallbacks under
`documentation/assets/diagrams/`, adds their Markdown image references, and
updates the manifest. The second command fails when a Mermaid definition, theme,
fallback asset, or Markdown link is stale. Do not edit generated SVGs or the
manifest by hand. Plain Markdown renderers display the SVG; MkDocs hides that
fallback and renders the same canonical Mermaid definition interactively.

## Visual guide source

Dashboard user guides live under `documentation/spaces/`. Personal Space
topics use frontmatter plus portable Markdown so the native dashboard reader and
MkDocs render the same source. Their screenshots live under
`documentation/assets/spaces/personal/` and are served with private,
no-cache response headers through both authenticated documentation routes.
`npm run docs:generate` derives `mkdocs.yml` from the same frontmatter; leave
`mkdocs.template.yml` for static MkDocs configuration only.

Capture screenshots from the real dashboard at 1920 x 873. Before committing,
blur memory content and author cells, memory view/edit content, Application
updates user and Bitbucket URL fields, and the profile email. Never commit a raw
capture containing those values.

The Memory Graph guide keeps two Chrome-rendered references: a project-scoped 3D
overview (`memory-graph-overview.png`) and a selected-node 2D focus state
(`memory-graph-focus.png`). Keep the project filter visible in both captures so
the public guide demonstrates the same corpus boundary without exposing records
from unrelated projects.
