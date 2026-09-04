# =============================================================================
# persistent-memory-dlp — configuration (env -> Settings)
#
# All runtime config comes from the process environment (docker-compose sets it;
# see the `dlp` service block in ../../deploy/compose/docker-compose.yml). NO .env file is read here
# on purpose — in the container the env is compose-injected and authoritative.
#
# SCOPE NOTE: like graphiti-service, this sidecar does NO inbound auth. It is
# internal-only (no published host port) and trusts the TS api/worker on the
# private compose network — the api is the choke-point that derives identity. It
# holds NO privileged resource (unlike docker-control, which guards the Docker
# socket and therefore needs a token), so the internal-network trust is sufficient.
# =============================================================================
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # --- HTTP bind (the actual uvicorn bind is pinned to --port 8200 in the
    # Dockerfile CMD; these are informational / for programmatic launch). --------
    host: str = "0.0.0.0"
    port: int = 8200

    # --- gitleaks (official static binary, installed in the Dockerfile) ---------
    gitleaks_bin: str = "gitleaks"
    gitleaks_timeout_s: float = 10.0

    # --- presidio defaults ------------------------------------------------------
    # Detections below this confidence are filtered server-side by Presidio. The
    # caller (api/worker) also passes its own entity deny-list per request.
    default_score_threshold: float = 0.5


@lru_cache
def get_settings() -> Settings:
    return Settings()
