# Onboarding

## Owns
- Capability: install wizard, agent rules, registrations, and install flows.
- Runtime touchpoints: host-only installer, initial setup, and registration writes.
- Dashboard touchpoints: first-run setup and connection guidance.
- Data stores: install state, generated config, and onboarding records.
- Extracted source modules:
  - `src/server/guard.ts` owns loopback origin/host guard decisions.
  - `src/server/steps.ts` owns pure install-step planning and output parsers.

The host-only installer keeps compatibility exports at `apps/onboard/server/*`
so existing server imports and tests keep working while capability code lives
here.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- The runnable host-only installer shell in `apps/onboard`.

## Verification
- Layer checks live under `test/layers/onboarding/`.
