#!/usr/bin/env bash
# Timeline keyset-pagination contract.
#
# Unlike the dependency-free unit tests wired into `npm test`, this test imports
# graph.py, whose module-level imports need the service's real dependency set
# (anthropic, graphiti-core, redis). It therefore runs inside the built graphiti
# image. It stubs the driver, so it touches no FalkorDB instance and no graph
# data — building the image does not recreate the running stack's container.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"

docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory build graphiti

# The runtime image deliberately excludes tests/ (see .dockerignore), so the
# suite is mounted read-only next to the app code it exercises.
docker run --rm --entrypoint python \
  -v "$root/apps/graphiti-service/tests:/app/tests:ro" \
  "${PM_IMAGE_PREFIX:-persistent-memory}-graphiti:latest" \
  -m unittest discover -s tests -p test_timeline_pagination.py
