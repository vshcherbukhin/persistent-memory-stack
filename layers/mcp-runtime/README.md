# MCP Runtime

## Owns
- Capability: MCP tool runtime, recall-context, sessions, and shared-connection behavior.
- Runtime touchpoints: Streamable HTTP MCP service and connector-backed session flow.
- Dashboard touchpoints: MCP registration and connection status surfaces.
- Data stores: session state, tool routing state, and connector metadata.
- Package: `@pm/mcp-runtime`, consumed by the `apps/mcp` stream-service shell.
- Source modules:
  - `src/tools/` owns MCP tool registration for identity, memories,
    recall-context, graph, documents, and investigations.
  - `src/session.ts`, `src/http-session.ts`, and `src/http-idle.ts` own
    Streamable HTTP session lifecycle helpers.
  - `src/api-client.ts`, `src/runtime.ts`, and `src/bridge.ts` own API routing,
    runtime resolution, and the client-managed embedding bridge. The bridge reports
    canonical embedding success/failure observations best-effort; the API derives
    the client scope from authentication so the runtime never supplies a user or
    global health identity.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shell ownership owned by the planned `apps/` boundary; current
  app shell folders stay in their existing top-level locations until the app
  move phase.

## Compatibility
- `apps/mcp/src/*` and `apps/mcp/src/tools/*` keep compatibility exports for
  existing tests and imports while the runtime implementation lives here.

## Verification
- Layer checks live under `test/layers/mcp-runtime/`.

## Health boundary

The bridge's local failures are classified only as safe canonical conditions
(quota, rate-limit, unavailable provider/model, or timeout). Reporting them must
never delay the memory-tool result, leak upstream text, or turn one client's local
failure into another client's status. Fact-extraction quota failures come from the
API error boundary and retain the exact MCP text: `Fact extraction is out of tokens.
The memory was not saved.`
