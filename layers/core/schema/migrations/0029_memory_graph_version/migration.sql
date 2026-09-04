-- Decouple graph-content optimistic concurrency from general Memory.updated_at.
-- Existing rows inherit their last known row version; future metadata/session/
-- access/vector-only writes leave graph_version untouched.
ALTER TABLE "memory" ADD COLUMN "graph_version" TIMESTAMP(3);
UPDATE "memory" SET "graph_version" = "updated_at" WHERE "graph_version" IS NULL;
ALTER TABLE "memory" ALTER COLUMN "graph_version" SET NOT NULL;
ALTER TABLE "memory" ALTER COLUMN "graph_version" SET DEFAULT CURRENT_TIMESTAMP;
