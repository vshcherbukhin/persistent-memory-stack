# Evidence Files

## Owns
- Capability: file ingestion, extraction, chunking, and evidence storage.
- Runtime touchpoints: API uploads, worker processing, and storage sidecars.
- Dashboard touchpoints: evidence upload and inspection surfaces.
- Data stores: MinIO blobs plus extracted document artifacts.
- Package: `@pm/evidence-files`, consumed by the API and worker app shells.
- Source modules:
  - `src/api/storage.ts` owns the API MinIO client singleton.
  - `src/worker/persist-chunks.ts` owns worker-side chunk persistence.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shell ownership owned by the planned `apps/` boundary; current
  app shell folders stay in their existing top-level locations until the app
  move phase.

## Compatibility
- `apps/api/src/services/storage.ts` and
  `apps/worker/src/steps/persist-chunks.ts` remain compatibility exports for
  existing imports while the helper implementations live here.
- Route modules, pipeline orchestration, and tenant/dependency wiring stay in
  `apps/` until they can move without crossing app-shell boundaries.

## Verification
- Layer checks live under `test/layers/evidence-files/`.
