# Dashboard

## Owns
- Capability: dashboard shell, personal/shared/server operator views, settings, services, logs, notifications, and memory management.
- Runtime touchpoints: Next.js dashboard shell, gateway handoff, and server-side API calls.
- Dashboard touchpoints: the user-facing dashboard surfaces themselves.
- Data stores: dashboard preferences, update state, and display data fetched from core services.
- Extracted source modules:
  - `src/lib/clientUpdate.ts`
  - `src/lib/logFormat.ts`
  - `src/lib/passwordStrength.ts`
  - `src/lib/releaseHistory.ts`

The standalone Next app keeps compatibility exports at
`apps/dashboard/src/lib/*` so existing imports and tests keep working while the
capability code lives here.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- The runnable Next.js app shell in `apps/dashboard`.

## Verification
- Layer checks live under `test/layers/dashboard/`.
