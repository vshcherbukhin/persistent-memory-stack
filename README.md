# persistent-memory

Persistent Memory turns MCP-compatible AI coding assistants into collaborators
that remember your work. Instead of re-explaining your project, decisions, and
context every time a chat ends, you can carry that knowledge forward across
conversations and projects — with Claude, Codex, and other compatible assistants.

- **Keep momentum across sessions** — retain the decisions, context, and knowledge
  that make your work understandable.
- **Work with the assistants you already use** — connect Claude, Codex, and other
  MCP-compatible tools to the same durable memory.
- **Start privately, share when ready** — keep a personal memory space for your
  own work, then connect shared knowledge when collaboration needs it.
- **Spend less time repeating yourself** — give every new conversation a stronger
  starting point, so the assistant can help sooner and with better context.

### Built for trustworthy memory

- **Understand how work evolved** — a built-in knowledge graph connects people,
  decisions, and events through time, so an agent can follow the story behind a
  project instead of only finding related memories.
- **Keep the evidence attached** — documents and their memories stay connected,
  making important context easier to trace back to its source.
- **Protect what should stay private** — layered safeguards help prevent sensitive
  information from being exposed as shared AI context.
- **Keep memory working behind the scenes** — managed background services process
  files, recover interrupted work, refresh the knowledge graph, and maintain
  memory quality as your projects change.
- **Rank context without hiding its history** — retrieval refreshes the recency
  of memories the agent actually uses while the graph keeps the separate
  timeline of how related facts evolved.
- **Repair graph changes safely** — graph episode provenance lets the lifecycle
  path target the original derived context rather than guessing from a memory
  name.
- **Review destructive graph changes clearly** — memory removal shows its live
  graph impact before confirmation, including the extra cascade risk of deleting
  a primary source.
- **Verify every release honestly** — the release System Health Report makes
  its expected behaviour, measured graph/retrieval costs, validation evidence,
  explicit limitations, and disposable-run cleanup proof visible in one
  reproducible document.
- **Keep recall complete without flooding context** — one bounded response keeps
  unique graph facts visible through references, reports any previews or omissions,
  and preserves identifiers for deeper follow-up reads.
- **Avoid paying twice for unchanged memory** — exact and same-value updates skip
  extraction, embedding, and graph work while real content edits keep the full
  quality pipeline.
- **See how your memory is connected** — the Memories page renders the authorized
  corpus as a live memory graph: a rotatable 3D sphere that flattens to a readable
  2D map of one memory's connections when you select a node, and returns to exactly
  the view you left when you close it.

## 🚀 Quick start

```bash
# launches guided web installer
npm run install-persistent-memory
```

```bash
# auto-updates the project with latest changes
npm run update-persistent-memory
```

```bash
# exports memories when requested, then removes the local stack
npm run uninstall-persistent-memory
```

### Disposable integration tests

Live integration tests never run against a Personal or Shared Memories install.
They start a separately namespaced server-mode DEV stack with its own Docker
containers, images, volumes, network, ports, and bootstrap token:

```bash
npm run dev-test:up
# add a scoped fact-extraction provider key to .local/dev-test-stack/.env
npm run dev-test:run
npm run dev-test:down
```

The runner rejects any API that does not explicitly report the disposable
`testStack:true` marker. See [`test/integration/README.md`](test/integration/README.md).

## 📖 Documentation

```bash
npm run docs:serve
```

Read the full product, installation, dashboard, and stack documentation in
[`documentation/`](documentation/).

## Deployment-agnostic source

Repository hosts, owners, project keys, repository slugs, and branches are runtime
settings. Configure update discovery with `UPDATE_BITBUCKET_URL`,
`UPDATE_BITBUCKET_SCOPE`, `UPDATE_BITBUCKET_PROJECT` or `UPDATE_BITBUCKET_USER`,
`UPDATE_BITBUCKET_REPO`, and `UPDATE_BITBUCKET_BRANCH`; do not add real deployment
identifiers to UI placeholders, tool schemas, prompts, fixtures, or documentation.

`npm run test:deployment-agnosticism` checks tracked filenames and text against the
project denylist. It is also part of the root `npm test` path.
