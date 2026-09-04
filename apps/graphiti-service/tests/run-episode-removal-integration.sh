#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
fixture="pm-graphiti-delete-fixture-$$"

cleanup() {
  docker stop "$fixture" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$root"
docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory build graphiti
docker run --rm -d --name "$fixture" falkordb/falkordb:v4.18.10 >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$fixture" redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker run --rm \
  --network "container:$fixture" \
  -e GRAPHITI_INTEGRATION_FALKOR_HOST=127.0.0.1 \
  -v "$root/apps/graphiti-service/tests:/tmp/tests:ro" \
  persistent-memory-graphiti:latest \
  python -m unittest discover -s /tmp/tests -p test_episode_removal_integration.py
