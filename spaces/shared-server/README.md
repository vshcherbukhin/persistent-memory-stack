# Shared Server

## Owns
- Runtime/deployment mode: shared-memory server and operator environment.
- Primary user: super-admin and server operators.
- Dashboard behavior: operator dashboard for shared-server administration.
- MCP behavior: issues and validates connector-token backed shared connections.
- API behavior: shared-memory server APIs, operator endpoints, and permission enforcement.

## Does Not Own
- Product capabilities owned by `layers/`
- Runnable app shells owned by the planned `apps/` boundary; current app shell
  folders stay in their existing top-level locations until the app move phase.

## Verification
- Space-specific checks live under `test/spaces/shared-server/`.
