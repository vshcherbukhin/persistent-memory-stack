/**
 * persistent-memory-api — Graphiti client singleton (Phase 7).
 *
 * One typed GraphitiClient built at boot from GRAPHITI_URL + GRAPHITI_TIMEOUT_MS.
 * Used by the /graph/* read routes (search/timeline/contradictions) and by
 * POST /memories' best-effort episode write. Mirrors services/embedding.ts and
 * services/storage.ts: this module only holds the instance.
 */
import { GraphitiClient } from '../clients/graphiti.ts'
import { config } from '../config.ts'

export const graphiti: GraphitiClient = new GraphitiClient(
  config.GRAPHITI_URL,
  config.GRAPHITI_TIMEOUT_MS,
)
