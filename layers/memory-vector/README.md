# Memory Vector

## Owns
- Capability: embeddings, Qdrant collections, search, rerank, and memory protocol routing.
- Runtime touchpoints: API writes, worker ingestion, and MCP recall paths.
- Dashboard touchpoints: memory search and memory detail surfaces.
- Data stores: Qdrant collections and vector-backed memory metadata.
- Package: `@pm/memory-vector`, consumed by the API app shell.
- Source modules:
  - `src/api/embedding-topology.ts` owns compatibility mapping between DB,
    wire, and topology names for server/client-managed embeddings.
  - `src/search/rerank.ts` owns provenance-aware memory search reranking: query
    relevance, access recency, and shape importance, gated by provenance ×
    write-time confidence.

## Does Not Own
- Deployment-space decisions owned by `spaces/`
- Runnable app shell ownership owned by the planned `apps/` boundary; current
  app shell folders stay in their existing top-level locations until the app
  move phase.

## Compatibility
- `apps/api/src/services/embedding-topology.ts` and
  `apps/api/src/services/rerank.ts` remain compatibility exports for existing
  API imports while the helper implementations live here.

## Verification
- Layer checks live under `test/layers/memory-vector/`.
