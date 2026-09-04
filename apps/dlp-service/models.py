# =============================================================================
# persistent-memory-dlp — request/response models.
#
# The /scan contract is deliberately REDACTION-SAFE: findings carry the TYPE and
# (for PII) the offset, NEVER the raw secret/PII value. Presidio returns
# entity_type + start/end + score (no substring); gitleaks runs with --redact so
# its report never contains the secret. The caller stores these on SecurityAlert.
# =============================================================================
from __future__ import annotations

from pydantic import BaseModel


class ScanRequest(BaseModel):
    text: str
    language: str = "en"
    # Restrict PII detection to these entity types (the caller's deny-list). None
    # = detect all default recognizers.
    entities: list[str] | None = None
    score_threshold: float = 0.5


class PiiFinding(BaseModel):
    entity_type: str
    start: int
    end: int
    score: float


class SecretFinding(BaseModel):
    rule_id: str
    description: str


class ScanResponse(BaseModel):
    pii: list[PiiFinding]
    secrets: list[SecretFinding]
    # Convenience: any PII (already filtered to the caller's entities) OR any secret.
    block: bool


class HealthResponse(BaseModel):
    status: str
    analyzer_ready: bool
    gitleaks: str
