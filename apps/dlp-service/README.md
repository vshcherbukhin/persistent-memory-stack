# persistent-memory-dlp

A small Python/FastAPI **DLP (data-loss-prevention) sidecar** that detects **PII**
and **secrets** in text. It is the detection backend for the api
write-gate and the worker (document-ingest block + the `pii-scan` scheduled job)
call it over the private compose network.

It mirrors `graphiti-service`: a thin FastAPI wrapper around **official** libraries —
detection is **not** hand-rolled.

- **PII** → Microsoft **Presidio** `AnalyzerEngine` (the exact `presidio-analyzer`
  package that lives inside MS's prebuilt image; we run it as a library so one
  sidecar can also host gitleaks). NER + pattern recognizers; returns
  `entity_type + start/end + score` — never the raw value.
- **Secrets** → the official **gitleaks** static binary (`gitleaks stdin`,
  `--redact` so the report never contains the secret). Pinned + checksum-verified
  in the Dockerfile.

## Why one sidecar (not a binary in api+worker, not MS's image)

gitleaks has no server mode, so vendoring it as a binary would duplicate it in both
the api and worker images. Hosting **both** detectors in one service gives a single
`/scan` endpoint and a single fail-closed client shared by api + worker, with zero
duplication — and detection quality is identical to the official tools because we
call them directly.

## Endpoints

| Method | Path           | Auth | Purpose |
|--------|----------------|------|---------|
| GET    | `/healthcheck` | none | Liveness (analyzer ready + gitleaks version). |
| POST   | `/scan`        | none | Detect PII + secrets in `text`. |

`POST /scan` request:

```json
{ "text": "...", "language": "en", "entities": ["US_SSN","EMAIL_ADDRESS"], "score_threshold": 0.5 }
```

`entities` restricts PII detection to the caller's deny-list (omit = all default
recognizers). Response:

```json
{ "pii": [{"entity_type":"US_SSN","start":49,"end":60,"score":0.85}],
  "secrets": [{"rule_id":"aws-access-token","description":"AWS Access Token"}],
  "block": true }
```

`block` = any PII (already filtered to `entities`) OR any secret.

## Security posture

- **Internal-only** — no published host port; reached only by the api/worker on
  `persistent_memory_network`. NO inbound auth (the api is the choke-point), exactly
  like `graphiti-service`. It holds no privileged resource (contrast `docker-control`,
  which guards the Docker socket and therefore needs a token).
- **Fail-closed** — any gitleaks spawn/timeout/unexpected-exit/parse error → HTTP
  500, so the caller blocks the write rather than letting unscanned text through.
- **Redaction-safe** — findings never carry the raw secret/PII value.
- Runs as a non-root user; the gitleaks binary is pinned (`GITLEAKS_VERSION` build
  arg) and sha256-verified.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `HOST` / `PORT` | `0.0.0.0` / `8200` | bind (the real bind is pinned in the Dockerfile CMD) |
| `GITLEAKS_BIN` | `gitleaks` | binary name/path |
| `GITLEAKS_TIMEOUT_S` | `10` | per-scan timeout (fail-closed past it) |
| `DEFAULT_SCORE_THRESHOLD` | `0.5` | PII confidence floor |

## Local run

```bash
pip install -r requirements.txt && python -m spacy download en_core_web_lg
# install the gitleaks binary on your PATH, then:
uvicorn main:app --port 8200
```

In the stack it runs as the `dlp` compose service (`deploy/compose/docker-compose.yml`).
