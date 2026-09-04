# =============================================================================
# persistent-memory-graphiti — configuration (env -> Settings)
#
# All runtime config comes from the process environment (docker-compose sets it;
# see the `graphiti` service block in ../../deploy/compose/docker-compose.yml + ../../.env.persistent-memory).
# There is NO .env file read here on purpose: in the container the env is already
# populated by compose, and reading a stray .env would mask the real source.
#
# SCOPE NOTE: this service does NO auth. It trusts every group_id the TS API
# passes (the API is the choke-point that derives readableTeams from identity).
# So there is intentionally no token / secret-verification config here.
#
# EMBEDDER NOTE: the embedder configured here embeds GRAPHITI'S OWN graph
# nodes/edges and is ALWAYS server-side. It is unrelated to the Qdrant CHUNK
# vector Mode A/B client-bridge toggle (that lives in P5 / the TS side). Do NOT
# plumb EMBEDDING_MODE into this service.
# =============================================================================
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # env_file=None: in-container env is authoritative (compose-injected). extra
    # vars in the environment (the api/worker share a big .env) are ignored.
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # --- HTTP bind -----------------------------------------------------------
    # NOTE: the actual uvicorn bind is pinned to --port 8100 in the Dockerfile
    # CMD (upstream graph_service defaults to 8000 — do NOT inherit that). These
    # are informational / used only if the app is launched programmatically.
    host: str = "0.0.0.0"
    port: int = 8100

    # --- graph backend (driver chosen by GRAPH_BACKEND) ----------------------
    graph_backend: str = "falkordb"  # "falkordb" (primary) | "neo4j"

    # FalkorDB — container name + INTERNAL port 6379 (host map is 6380; never use
    # the host port container-to-container).
    falkordb_host: str = "persistent-memory-falkordb"
    falkordb_port: int = 6379
    falkordb_username: str | None = None
    falkordb_password: str | None = None
    falkordb_database: str = "default_db"

    # Neo4j — bolt, INTERNAL port 7687 (host map is 7688). The neo4j service is
    # compose profile-gated (off by default); these are only used when
    # GRAPH_BACKEND=neo4j.
    neo4j_uri: str = "bolt://persistent-memory-neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "persistentmemory"
    neo4j_database: str = "neo4j"

    # --- extraction LLM (cloud, configurable) --------------------------------
    extraction_provider: str = "anthropic"  # "anthropic" | "openai"
    # Quality-first default for entity/edge extraction. Sonnet 4.6 ≫ Haiku for
    # extraction quality (cost tradeoff: graphiti reuses this as small_model for
    # every sub-step — drop to a cheaper model here if cost matters at scale).
    extraction_model: str = "claude-sonnet-4-6"
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    # OpenAI-compatible base URL override. Lets the "openai" provider target a
    # LOCAL Ollama at http://host:11434/v1 (read from OPENAI_BASE_URL).
    openai_base_url: str | None = None

    # Usage metrics: report extraction-LLM token usage to the api's
    # POST /internal/usage (for the dashboard Usage page). This is an OUTBOUND
    # authenticated call only — it does NOT change this service's INBOUND posture
    # (still no inbound auth; the api/worker reach it on the internal network).
    # Empty token ⇒ reporting is skipped (the api endpoint also fails closed).
    usage_ingest_token: str | None = None
    api_url: str = "http://persistent-memory-api:8090"

    # --- embedder (server-side, always) --------------------------------------
    embed_provider: str = "ollama"  # "ollama" | "openai" | "voyage"
    embed_model: str = "qwen3-embedding:4b"
    embed_dim: int = 2560
    # Host Ollama (OpenAI-compatible at /v1). The service appends /v1 itself.
    ollama_url: str = "http://host.docker.internal:11434"
    voyage_api_key: str | None = None

    # --- concurrency ---------------------------------------------------------
    # graphiti_core reads SEMAPHORE_LIMIT from the *process environment* (not a
    # constructor arg) to cap concurrent LLM/embedder ops and dodge 429s. main.py
    # re-exports this into os.environ before importing graphiti_core. Tune by
    # provider tier: OpenAI T1 ~1-2 / T3 ~10-15; Anthropic mid ~10. Lower on 429s.
    semaphore_limit: int = 10

    def embedder_label(self) -> str:
        """Human-readable embedder id for the healthcheck payload."""
        return f"{self.embed_provider}/{self.embed_model}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
