-- Phase 8: pii-scan cursor. `pii_scanned_at` on memory + chunk makes the periodic
-- DLP scan IDEMPOTENT + PROGRESSIVE: the scan takes a bounded batch of rows where
-- pii_scanned_at IS NULL OR updated_at > pii_scanned_at (never scanned, or edited
-- since the last scan), then stamps pii_scanned_at = now() — so the next run skips
-- them and re-scans only edits. (The write-gate is the primary guard; this is the
-- safety net for legacy / Mode-B / pre-gate rows.) Both are DATA tables that already
-- have RLS (no rls.sql change needed — adding a column doesn't alter the policies).

-- AlterTable
ALTER TABLE "memory" ADD COLUMN "pii_scanned_at" TIMESTAMP(3);
ALTER TABLE "chunk" ADD COLUMN "pii_scanned_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "memory_pii_scanned_at_idx" ON "memory"("pii_scanned_at");
CREATE INDEX "chunk_pii_scanned_at_idx" ON "chunk"("pii_scanned_at");
