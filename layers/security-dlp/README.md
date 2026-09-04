# Security DLP

## Owns
- Capability: DLP gate, security alerts, and RLS enforcement support.
- Runtime touchpoints: API write gate, worker scans, and security sidecars.
- Dashboard touchpoints: security status and alert surfaces.
- Data stores: security findings, policy state, and RLS-protected records.
- Package: `@pm/security-dlp`, consumed by the API and worker app shells.
- Source modules:
  - `src/dlp-gate/index.ts` owns the fail-closed HTTP client and redaction-safe
    DLP gate decision.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shells owned by `apps/`.
- The Python `apps/dlp-service` sidecar runtime.

## Verification
- Layer checks live under `test/layers/security-dlp/`.
