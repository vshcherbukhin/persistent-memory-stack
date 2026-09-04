ALTER TABLE "app_user"
  ADD COLUMN "token_issued_at" TIMESTAMP(3);

UPDATE "app_user"
SET "token_issued_at" = "updated_at"
WHERE "token_id" IS NOT NULL
  AND "token_issued_at" IS NULL;
