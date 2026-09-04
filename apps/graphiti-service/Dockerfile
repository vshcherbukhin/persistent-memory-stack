# syntax=docker/dockerfile:1
# =============================================================================
# persistent-memory-graphiti — Python/FastAPI temporal-graph microservice (P4)
#
# Internal-only service: reached only by the TS api/worker over the private
# compose network (persistent_memory_network). Does NO auth — trusts group_ids
# the API supplies. Endpoint surface: GET /healthcheck, POST /episodes,
# POST /search, GET /timeline, GET /contradictions.
#
# Two-stage build:
#   1. builder — install deps into an isolated venv on python:3.12-slim.
#   2. runtime — copy the venv + app onto a fresh slim base, run as non-root.
# graphiti-core 0.29.2 requires Python >=3.10,<4 → python:3.12-slim is in range.
#
# PORT CONTRACT (do NOT regress): upstream Graphiti's own server defaults to
# 8000. This service MUST bind 8100 to match deploy/compose/docker-compose.yml (8100:8100),
# GRAPHITI_URL=http://persistent-memory-graphiti:8100, and the compose
# healthcheck that probes :8100/healthcheck. The CMD pins --port 8100 explicitly.
# =============================================================================

# ----------------------------------------------------------------------------
# Stage 1 — builder: resolve + install deps into /opt/venv
# ----------------------------------------------------------------------------
FROM python:3.12-slim AS builder

# Build-time toolchain for any wheels that need compiling (graphiti-core deps are
# largely pure-python/prebuilt wheels, but keep gcc available for safety). These
# stay in the builder stage only — never shipped in the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Isolated venv so the runtime stage copies a self-contained tree.
ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Install deps first (own layer) so app-code edits don't bust the dep cache.
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# ----------------------------------------------------------------------------
# Stage 2 — runtime: slim image, venv + app, non-root
# ----------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# - PYTHONUNBUFFERED: logs flush immediately (visible in `docker compose logs`).
# - PYTHONDONTWRITEBYTECODE: no .pyc clutter on the app tree.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

# Non-root runtime user (defense-in-depth; the service holds cloud API keys).
RUN groupadd --system app && useradd --system --gid app --no-create-home app

# Bring the fully-installed venv over from the builder.
COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
# App code (main.py exposes `app`; supporting modules alongside). Owned by app.
COPY --chown=app:app . /app

USER app

# Internal-only port. Documents intent; the host mapping lives in compose.
EXPOSE 8100

# In-image liveness probe mirrors the compose healthcheck so the image is
# self-describing and works under bare `docker run` too. python:3.12-slim has no
# curl; use the stdlib urllib instead (no extra deps).
HEALTHCHECK --interval=15s --timeout=10s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8100/healthcheck').status==200 else 1)" || exit 1

# --port 8100 is REQUIRED — upstream defaults to 8000. main:app is THIS service's
# FastAPI app (apps/graphiti-service/main.py), NOT upstream graph_service.main:app.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
