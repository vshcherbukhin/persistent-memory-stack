# =============================================================================
# persistent-memory-dlp — FastAPI sidecar for PII + secret detection (Phase 8, #10)
#
# A thin wrapper (mirrors graphiti-service) around two OFFICIAL detectors:
#   • Presidio AnalyzerEngine (the same package inside MS's presidio-analyzer image)
#     for PII — NER + pattern recognizers; returns type+offset+score, no raw value.
#   • the official gitleaks static binary for secrets — `gitleaks stdin`, run with
#     --redact so the report never contains the secret.
#
# Endpoint surface: GET /healthcheck, POST /scan. NO inbound auth (internal-only,
# like graphiti-service). FAIL-CLOSED: any gitleaks spawn/exit/parse error → 500,
# so the caller (api write-gate / worker scan) blocks the write rather than letting
# unscanned content through.
# =============================================================================
from __future__ import annotations

import json
import logging
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from presidio_analyzer import AnalyzerEngine

from config import get_settings
from models import HealthResponse, PiiFinding, ScanRequest, ScanResponse, SecretFinding

settings = get_settings()
logger = logging.getLogger("persistent_memory.dlp")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Build the analyzer once — loads the spaCy NLP pipeline (slow; the compose
    # healthcheck start_period covers it). Reused across every request.
    app.state.analyzer = AnalyzerEngine()
    yield


app = FastAPI(title="persistent-memory-dlp", lifespan=lifespan)


def _gitleaks_version() -> str:
    try:
        out = subprocess.run([settings.gitleaks_bin, "version"], capture_output=True, timeout=5)
        return out.stdout.decode().strip() or "unknown"
    except Exception:  # noqa: BLE001 — health probe, never raise
        return "unavailable"


def scan_secrets(text: str) -> list[SecretFinding]:
    """Run gitleaks over `text` via stdin. FAIL-CLOSED: any spawn/timeout/unexpected
    exit/parse error raises HTTPException(500) so the caller blocks the write.
    Exit code is the pivot: 0 = clean, 7 = leak(s) found (our --exit-code), anything
    else = operational error (block + surface)."""
    try:
        proc = subprocess.run(
            [
                settings.gitleaks_bin, "stdin",
                "--no-banner", "--no-color", "--log-level=error",
                "--report-format=json", "--report-path=-",
                "--redact", "--exit-code=7",
            ],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=settings.gitleaks_timeout_s,
        )
    except FileNotFoundError as e:
        logger.exception("gitleaks scan failed")
        raise HTTPException(status_code=500, detail=f"gitleaks binary not found: {e}")
    except subprocess.TimeoutExpired:
        logger.exception("gitleaks scan failed")
        raise HTTPException(status_code=500, detail="gitleaks scan timed out")

    if proc.returncode not in (0, 7):
        logger.error("gitleaks scan failed with exit code %s", proc.returncode)
        raise HTTPException(
            status_code=500,
            detail=f"gitleaks failed (exit {proc.returncode}): {proc.stderr.decode()[:500]}",
        )

    out = proc.stdout.decode().strip()
    if not out:
        return []
    try:
        findings = json.loads(out)
    except json.JSONDecodeError as e:
        logger.exception("gitleaks scan failed")
        raise HTTPException(status_code=500, detail=f"gitleaks output unparseable: {e}")

    return [
        SecretFinding(rule_id=f.get("RuleID", "unknown"), description=f.get("Description", ""))
        for f in findings
    ]


@app.get("/healthcheck", response_model=HealthResponse)
def healthcheck() -> HealthResponse:
    # Ready once the analyzer is built (the core service). gitleaks availability is
    # reported but does NOT fail the probe — a gitleaks hiccup blocks individual
    # writes (per-request fail-closed in /scan), not the whole stack's startup.
    ready = getattr(app.state, "analyzer", None) is not None
    return HealthResponse(status="ok", analyzer_ready=ready, gitleaks=_gitleaks_version())


@app.post("/scan", response_model=ScanResponse)
def scan(req: ScanRequest) -> ScanResponse:
    analyzer: AnalyzerEngine = app.state.analyzer
    results = analyzer.analyze(
        text=req.text,
        language=req.language,
        entities=req.entities or None,
        score_threshold=req.score_threshold,
    )
    pii = [
        PiiFinding(entity_type=r.entity_type, start=r.start, end=r.end, score=round(float(r.score), 4))
        for r in results
    ]
    secrets = scan_secrets(req.text)  # may raise 500 → caller fails closed
    return ScanResponse(pii=pii, secrets=secrets, block=bool(pii or secrets))
