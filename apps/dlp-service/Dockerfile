# syntax=docker/dockerfile:1
# =============================================================================
# persistent-memory-dlp — PII (Presidio) + secret (gitleaks) detection sidecar
#
# Internal-only service reached only by the TS api/worker over the private compose
# network. Does NO inbound auth (like graphiti-service). Surface: GET /healthcheck,
# POST /scan.
#
# Two-stage build:
#   1. builder — install presidio-analyzer + deps into a venv, fetch the spaCy
#      model, and download + checksum-verify the OFFICIAL gitleaks static binary.
#   2. runtime — copy the venv + the gitleaks binary + app onto a fresh slim base.
#
# PORT CONTRACT: binds 8200 (graphiti=8100). The CMD pins --port 8200 explicitly.
# =============================================================================

# ----------------------------------------------------------------------------
# Stage 1 — builder
# ----------------------------------------------------------------------------
FROM python:3.12-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Presidio's default NLP model (en_core_web_lg = what Microsoft's analyzer image
# ships; matched to the installed spaCy). Lands in the venv → copied to runtime.
RUN python -m spacy download en_core_web_lg

# Official gitleaks static binary, pinned + sha256-verified against the release
# checksums. CGO_ENABLED=0 static Go → runs on the slim runtime with no extra libs.
ARG GITLEAKS_VERSION=8.30.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gl_arch=x64 ;; \
      arm64) gl_arch=arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    asset="gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz"; \
    base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"; \
    cd /tmp; \
    # save under the REAL asset name so `sha256sum -c` (which reads the name from the
    # checksums line) finds the file it is verifying.
    curl -fsSL -o "$asset" "${base}/${asset}"; \
    curl -fsSL -o checksums.txt "${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    grep "$asset" checksums.txt | sha256sum -c -; \
    tar -xzf "$asset" -C /usr/local/bin gitleaks; \
    chmod +x /usr/local/bin/gitleaks; \
    /usr/local/bin/gitleaks version

# ----------------------------------------------------------------------------
# Stage 2 — runtime
# ----------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    # Presidio's email recognizer uses tldextract, which caches the public-suffix
    # list. Point it at a writable dir so the non-root user doesn't fail to cache +
    # retry over HTTP every startup (this sidecar is internet-less; tldextract falls
    # back to its bundled snapshot, but the writable cache silences the warning).
    TLDEXTRACT_CACHE=/tmp/tldextract

RUN groupadd --system app && useradd --system --gid app --no-create-home app

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /usr/local/bin/gitleaks /usr/local/bin/gitleaks

WORKDIR /app
COPY --chown=app:app . /app

USER app

EXPOSE 8200

# stdlib urllib probe (slim image has no curl). start_period is generous — the
# spaCy en_core_web_lg load on first boot takes several seconds.
HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=10 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8200/healthcheck').status==200 else 1)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8200"]
