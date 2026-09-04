-- Model-dependency health observations (control plane; owner-only).
--
-- There is one durable, redacted row per logical capability + observer scope.
-- Observer scope keeps client-managed providers isolated: a single client's
-- local Ollama failure must not degrade health for another client.

-- CreateEnum
CREATE TYPE "ModelDependencyHealthState" AS ENUM ('healthy', 'degraded', 'unhealthy', 'unknown');

-- CreateTable
CREATE TABLE "model_dependency_health" (
    "capability" TEXT NOT NULL,
    "observer_scope" TEXT NOT NULL,
    "state" "ModelDependencyHealthState" NOT NULL DEFAULT 'healthy',
    "provider" TEXT,
    "model" TEXT,
    "last_success_at" TIMESTAMP(3),
    "first_failure_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "safe_message" TEXT,
    "retryable" BOOLEAN,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_dependency_health_pkey" PRIMARY KEY ("capability", "observer_scope")
);

-- CreateIndex
CREATE INDEX "model_dependency_health_observed_at_idx" ON "model_dependency_health"("observed_at");

-- CreateIndex
CREATE INDEX "model_dependency_health_state_idx" ON "model_dependency_health"("state");
