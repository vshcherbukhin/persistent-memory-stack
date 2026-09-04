-- Local-mode identity pointer. The local user/team are real generated DB rows;
-- this singleton records which rows the no-auth local deployment should use.
CREATE TABLE "local_identity" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "team_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "local_identity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "local_identity_singleton_check" CHECK ("id" = 'singleton')
);

CREATE UNIQUE INDEX "local_identity_team_id_key" ON "local_identity"("team_id");
CREATE UNIQUE INDEX "local_identity_user_id_key" ON "local_identity"("user_id");

ALTER TABLE "local_identity"
  ADD CONSTRAINT "local_identity_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "local_identity"
  ADD CONSTRAINT "local_identity_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
