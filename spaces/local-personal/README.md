# Local Personal

## Owns
- Runtime/deployment mode: single-user local Personal Memories stack.
- Primary user: one person using the local machine.
- Dashboard behavior: local dashboard manages personal memories and local settings.
- MCP behavior: local Streamable HTTP MCP registers against the personal stack.
- API behavior: local API serves personal-scoped reads and writes with local identity.

## Does Not Own
- Product capabilities owned by `layers/`
- Runnable app shells owned by the planned `apps/` boundary; current app shell
  folders stay in their existing top-level locations until the app move phase.

## Verification
- Space-specific checks live under `test/spaces/local-personal/`.
