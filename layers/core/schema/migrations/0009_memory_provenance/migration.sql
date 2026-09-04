-- Phase 9: provenance / multi-tier memory (#11). Additive columns on the existing
-- `memory` DATA table — the RLS policies are unchanged (memory already has its own
-- own∪mounted read + team-write + owner-floor in rls.sql §5; new columns don't alter
-- the partition). Existing rows default to a moderate, unverified, agent-inferred,
-- semantic memory — a safe baseline for the rerank's provenance gate.

-- CreateEnum
CREATE TYPE "MemoryTier" AS ENUM ('semantic', 'episodic', 'procedural', 'working');
CREATE TYPE "SourceProvenance" AS ENUM ('human_verified', 'api_return', 'agent_inferred');

-- AlterTable
ALTER TABLE "memory" ADD COLUMN "memory_tier" "MemoryTier" NOT NULL DEFAULT 'semantic';
ALTER TABLE "memory" ADD COLUMN "source_provenance" "SourceProvenance" NOT NULL DEFAULT 'agent_inferred';
ALTER TABLE "memory" ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6;
ALTER TABLE "memory" ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "memory" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "memory" ADD COLUMN "verified_by_id" UUID;
ALTER TABLE "memory" ADD COLUMN "evidence_gap" JSONB;
ALTER TABLE "memory" ADD COLUMN "last_accessed_at" TIMESTAMP(3);
ALTER TABLE "memory" ADD COLUMN "access_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "memory" ADD COLUMN "archived_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "memory_team_id_verified_idx" ON "memory"("team_id", "verified");
CREATE INDEX "memory_team_id_archived_at_idx" ON "memory"("team_id", "archived_at");
