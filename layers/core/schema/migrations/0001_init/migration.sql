-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('read', 'read_write');

-- CreateEnum
CREATE TYPE "AdminLevel" AS ENUM ('none', 'admin', 'superuser');

-- CreateEnum
CREATE TYPE "EmbeddingStatus" AS ENUM ('pending', 'embedded');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('queued', 'extracting', 'embedding', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('document', 'memory', 'conversation');

-- CreateEnum
CREATE TYPE "MemoryShape" AS ENUM ('gotcha_fix', 'user_correction', 'tool_gap', 'prd', 'atomic');

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "team_role" "TeamRole" NOT NULL DEFAULT 'read',
    "admin_level" "AdminLevel" NOT NULL DEFAULT 'none',
    "token_id" TEXT,
    "token_hash" TEXT,
    "token_expires" TIMESTAMP(3),
    "email" TEXT,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_grant" (
    "id" UUID NOT NULL,
    "grantor_team_id" UUID NOT NULL,
    "grantee_team_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "kind" "SourceKind" NOT NULL DEFAULT 'document',
    "title" TEXT,
    "uri" TEXT,
    "minio_object_key" TEXT,
    "session_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "source_id" UUID NOT NULL,
    "title" TEXT,
    "mime_type" TEXT,
    "minio_object_key" TEXT,
    "page_count" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER,
    "qdrant_point_id" UUID,
    "embedding_model_id" TEXT,
    "embedding_dim" INTEGER,
    "embedding_status" "EmbeddingStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "document_id" UUID,
    "name" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "document_id" UUID,
    "subject_entity_id" UUID,
    "statement" TEXT NOT NULL,
    "valid_at" TIMESTAMP(3),
    "invalid_at" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "subject_entity_id" UUID NOT NULL,
    "object_entity_id" UUID NOT NULL,
    "predicate" TEXT NOT NULL,
    "valid_at" TIMESTAMP(3),
    "invalid_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "session_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigation_link" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "investigation_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "investigation_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_job" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "source_id" UUID,
    "bull_job_id" TEXT,
    "status" "IngestStatus" NOT NULL DEFAULT 'queued',
    "session_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingest_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "project" TEXT NOT NULL DEFAULT 'general',
    "source_id" UUID,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "shape" "MemoryShape" NOT NULL,
    "entities" TEXT[],
    "session_id" TEXT,
    "qdrant_point_id" UUID,
    "embedding_model_id" TEXT,
    "embedding_dim" INTEGER,
    "embedding_status" "EmbeddingStatus" NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_name_key" ON "team"("name");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_token_id_key" ON "app_user"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "app_user_team_id_idx" ON "app_user"("team_id");

-- CreateIndex
CREATE INDEX "team_grant_grantee_team_id_idx" ON "team_grant"("grantee_team_id");

-- CreateIndex
CREATE INDEX "team_grant_grantor_team_id_idx" ON "team_grant"("grantor_team_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_grant_grantor_team_id_grantee_team_id_key" ON "team_grant"("grantor_team_id", "grantee_team_id");

-- CreateIndex
CREATE INDEX "source_team_id_project_idx" ON "source"("team_id", "project");

-- CreateIndex
CREATE INDEX "source_team_id_kind_idx" ON "source"("team_id", "kind");

-- CreateIndex
CREATE INDEX "source_session_id_idx" ON "source"("session_id");

-- CreateIndex
CREATE INDEX "document_team_id_project_idx" ON "document"("team_id", "project");

-- CreateIndex
CREATE INDEX "document_source_id_idx" ON "document"("source_id");

-- CreateIndex
CREATE INDEX "chunk_team_id_project_idx" ON "chunk"("team_id", "project");

-- CreateIndex
CREATE INDEX "chunk_team_id_embedding_status_idx" ON "chunk"("team_id", "embedding_status");

-- CreateIndex
CREATE INDEX "chunk_qdrant_point_id_idx" ON "chunk"("qdrant_point_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunk_document_id_ordinal_key" ON "chunk"("document_id", "ordinal");

-- CreateIndex
CREATE INDEX "entity_team_id_project_idx" ON "entity"("team_id", "project");

-- CreateIndex
CREATE INDEX "entity_team_id_name_idx" ON "entity"("team_id", "name");

-- CreateIndex
CREATE INDEX "entity_document_id_idx" ON "entity"("document_id");

-- CreateIndex
CREATE INDEX "claim_team_id_project_idx" ON "claim"("team_id", "project");

-- CreateIndex
CREATE INDEX "claim_team_id_valid_at_idx" ON "claim"("team_id", "valid_at");

-- CreateIndex
CREATE INDEX "claim_team_id_invalid_at_idx" ON "claim"("team_id", "invalid_at");

-- CreateIndex
CREATE INDEX "claim_subject_entity_id_idx" ON "claim"("subject_entity_id");

-- CreateIndex
CREATE INDEX "claim_document_id_idx" ON "claim"("document_id");

-- CreateIndex
CREATE INDEX "relationship_team_id_project_idx" ON "relationship"("team_id", "project");

-- CreateIndex
CREATE INDEX "relationship_subject_entity_id_idx" ON "relationship"("subject_entity_id");

-- CreateIndex
CREATE INDEX "relationship_object_entity_id_idx" ON "relationship"("object_entity_id");

-- CreateIndex
CREATE INDEX "relationship_team_id_predicate_idx" ON "relationship"("team_id", "predicate");

-- CreateIndex
CREATE INDEX "investigation_team_id_project_idx" ON "investigation"("team_id", "project");

-- CreateIndex
CREATE INDEX "investigation_team_id_status_idx" ON "investigation"("team_id", "status");

-- CreateIndex
CREATE INDEX "investigation_link_team_id_project_idx" ON "investigation_link"("team_id", "project");

-- CreateIndex
CREATE INDEX "investigation_link_target_type_target_id_idx" ON "investigation_link"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "investigation_link_investigation_id_target_type_target_id_key" ON "investigation_link"("investigation_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "ingest_job_team_id_project_idx" ON "ingest_job"("team_id", "project");

-- CreateIndex
CREATE INDEX "ingest_job_team_id_status_idx" ON "ingest_job"("team_id", "status");

-- CreateIndex
CREATE INDEX "ingest_job_source_id_idx" ON "ingest_job"("source_id");

-- CreateIndex
CREATE INDEX "memory_team_id_project_idx" ON "memory"("team_id", "project");

-- CreateIndex
CREATE INDEX "memory_team_id_category_idx" ON "memory"("team_id", "category");

-- CreateIndex
CREATE INDEX "memory_team_id_embedding_status_idx" ON "memory"("team_id", "embedding_status");

-- CreateIndex
CREATE INDEX "memory_entities_idx" ON "memory" USING GIN ("entities");

-- CreateIndex
CREATE INDEX "memory_session_id_idx" ON "memory"("session_id");

-- CreateIndex
CREATE INDEX "memory_qdrant_point_id_idx" ON "memory"("qdrant_point_id");

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_grant" ADD CONSTRAINT "team_grant_grantor_team_id_fkey" FOREIGN KEY ("grantor_team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_grant" ADD CONSTRAINT "team_grant_grantee_team_id_fkey" FOREIGN KEY ("grantee_team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source" ADD CONSTRAINT "source_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk" ADD CONSTRAINT "chunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "entity_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "entity_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim" ADD CONSTRAINT "claim_subject_entity_id_fkey" FOREIGN KEY ("subject_entity_id") REFERENCES "entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_subject_entity_id_fkey" FOREIGN KEY ("subject_entity_id") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_object_entity_id_fkey" FOREIGN KEY ("object_entity_id") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation" ADD CONSTRAINT "investigation_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_link" ADD CONSTRAINT "investigation_link_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_link" ADD CONSTRAINT "investigation_link_investigation_id_fkey" FOREIGN KEY ("investigation_id") REFERENCES "investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_job" ADD CONSTRAINT "ingest_job_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_job" ADD CONSTRAINT "ingest_job_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory" ADD CONSTRAINT "memory_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory" ADD CONSTRAINT "memory_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
