# Core

## Owns
- Capability: identity, auth, settings, usage, schema, and API contract foundations.
- Runtime touchpoints: Fastify API, worker data access, and shared identity flows.
- Dashboard touchpoints: core account, settings, and status surfaces.
- Data stores: Postgres metadata and RLS-backed tenant state.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shell ownership owned by the planned `apps/` boundary; current
  app shell folders stay in their existing top-level locations until the app
  move phase.

## Verification
- Layer checks live under `test/layers/core/`.
