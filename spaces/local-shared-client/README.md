# Local Shared Client

## Owns
- Runtime/deployment mode: local dashboard connected to one Shared Memories server.
- Primary user: a local user who may connect to shared memory.
- Dashboard behavior: local dashboard manages personal and shared surfaces plus connection state.
- MCP behavior: local Streamable HTTP MCP proxies shared actions through the stored connector token.
- API behavior: local API serves the client side and forwards shared requests through the connector flow.

## Does Not Own
- Product capabilities owned by `layers/`
- Runnable app shells owned by the planned `apps/` boundary; current app shell
  folders stay in their existing top-level locations until the app move phase.

## Verification
- Space-specific checks live under `test/spaces/local-shared-client/`.
