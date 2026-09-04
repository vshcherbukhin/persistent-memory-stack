# =============================================================================
# persistent-memory-graphiti — Graphiti client factory + temporal graph reads
#
# Builds the process-singleton Graphiti instance (driver + extraction LLM +
# server-side embedder) chosen by env, and exposes the backend-agnostic Cypher
# reads that back GET /timeline and GET /contradictions.
#
# graphiti-core 0.29.2 API (pinned against the v0.29.2 source):
#   Graphiti(graph_driver=..., llm_client=..., embedder=...)   # driver attr: self.driver
#   add_episode(name, episode_body, source_description, reference_time,
#               source=EpisodeType.message, group_id=None, uuid=None) -> AddEpisodeResults
#   search(query, center_node_uuid=None, group_ids=None, num_results=...) -> list[EntityEdge]
#   EntityEdge: created_at / valid_at / invalid_at / expired_at  (+ uuid, name,
#               fact, source_node_uuid, target_node_uuid, group_id, fact_embedding)
#
# AddEpisodeResults (0.29.2) = {episode, episodic_edges, nodes, edges,
#   communities, community_edges} — there is NO invalidated_edges field, so the
#   "what did this write supersede" diagnostic is derived via a driver query.
# =============================================================================
from __future__ import annotations

import asyncio
from contextvars import ContextVar
import json
import logging
import time
from typing import Any, Callable

from anthropic import AsyncAnthropic
import httpx
from redis.exceptions import ResponseError

from graphiti_core import Graphiti
from graphiti_core.driver.falkordb import STOPWORDS
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.driver.falkordb.operations import search_ops as falkordb_search_ops
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.helpers import validate_group_ids
from graphiti_core.llm_client.anthropic_client import AnthropicClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_client import OpenAIClient

from auth import anthropic_client_kwargs
from config import Settings
from usage_telemetry import graph_usage_payload


# -----------------------------------------------------------------------------
# Driver — selected by GRAPH_BACKEND. FalkorDB is primary; Neo4j is the
# switchable alternative (compose profile "neo4j"). Both speak (open)Cypher, so
# the temporal reads below are backend-agnostic.
# -----------------------------------------------------------------------------
logger = logging.getLogger("persistent_memory.graphiti")
FALKORDB_FULLTEXT_MAX_TERMS = 12


def sanitize_falkordb_fulltext_terms(query: str) -> str:
    """Keep upstream-generated RediSearch terms free of parser syntax.

    Graphiti derives these terms from arbitrary memory text while resolving a
    new episode. The opaque project group key is escaped separately by
    graphiti-core; for the text portion, retaining only alphanumeric terms
    makes every punctuation form (code delimiters, operators, URLs, and future
    RediSearch metacharacters) data rather than query syntax.
    """
    return " ".join("".join(char if char.isalnum() else " " for char in query).split())


def _falkordb_fulltext_terms(query: str) -> list[str]:
    """Return a bounded, order-preserving set of meaningful full-text terms.

    Graphiti's FalkorDB adapter turns each word into an OR clause. Long
    extracted facts therefore become broad RediSearch queries, even though its
    parallel vector/BFS signals already preserve graph resolution quality. A
    small unique prefix keeps the lexical candidate signal useful without
    letting one verbose memory issue a pathological read query.
    """
    terms: list[str] = []
    seen: set[str] = set()
    for word in sanitize_falkordb_fulltext_terms(query).split():
        normalized = word.lower()
        if normalized in STOPWORDS or normalized in seen:
            continue
        seen.add(normalized)
        terms.append(word)
        if len(terms) == FALKORDB_FULLTEXT_MAX_TERMS:
            break
    return terms


def build_falkordb_fulltext_query(
    query: str,
    group_ids: list[str] | None = None,
    max_query_length: int = 128,
) -> str:
    """Build the same scoped RediSearch query as Graphiti, with bounded terms."""
    validate_group_ids(group_ids)
    if group_ids:
        escaped_group_ids = [
            f'"{falkordb_search_ops._escape_fulltext_group_id(group_id)}"'
            for group_id in group_ids
        ]
        group_filter = f"(@group_id:{'|'.join(escaped_group_ids)})"
    else:
        group_filter = ""

    terms = _falkordb_fulltext_terms(query)
    if not terms:
        return ""
    fulltext_terms = " | ".join(terms)
    if len(fulltext_terms.split(" ")) + len(group_ids or []) >= max_query_length:
        return ""
    return f"{group_filter} ({fulltext_terms})"


def sanitize_falkordb_driver_terms(_driver: FalkorDriver, query: str) -> str:
    return sanitize_falkordb_fulltext_terms(query)


def build_falkordb_driver_fulltext_query(
    _driver: FalkorDriver,
    query: str,
    group_ids: list[str] | None = None,
    max_query_length: int = 128,
) -> str:
    return build_falkordb_fulltext_query(query, group_ids, max_query_length)


async def _fulltext_timeout_fallback(operation: str, callback):
    try:
        return await callback()
    except ResponseError as exc:
        if "query timed out" not in str(exc).lower():
            raise
        # Full-text is one candidate signal in Graphiti's hybrid resolution
        # search. Returning no BM25 candidates preserves vector/BFS/exact-node
        # resolution and lets the write finish instead of rejecting the memory.
        logger.warning(
            "FalkorDB %s full-text search timed out; continuing with hybrid fallback",
            operation,
        )
        return []


_original_falkordb_node_fulltext_search = falkordb_search_ops.FalkorSearchOperations.node_fulltext_search
_original_falkordb_edge_fulltext_search = falkordb_search_ops.FalkorSearchOperations.edge_fulltext_search


async def _timeout_tolerant_falkordb_node_fulltext_search(self, *args, **kwargs):
    return await _fulltext_timeout_fallback(
        "node",
        lambda: _original_falkordb_node_fulltext_search(self, *args, **kwargs),
    )


async def _timeout_tolerant_falkordb_edge_fulltext_search(self, *args, **kwargs):
    return await _fulltext_timeout_fallback(
        "relationship",
        lambda: _original_falkordb_edge_fulltext_search(self, *args, **kwargs),
    )


# graphiti-core 0.29.2 has a separate operations implementation for episode
# extraction that bypasses FalkorDriver.sanitize(). Patch that runtime path to
# the same bounded, allow-list rule as the direct driver path below. It also
# clones a plain FalkorDriver per project graph, so patch the base class rather
# than relying only on our startup driver subclass.
falkordb_search_ops._sanitize = sanitize_falkordb_fulltext_terms
falkordb_search_ops._build_falkor_fulltext_query = build_falkordb_fulltext_query
FalkorDriver.sanitize = sanitize_falkordb_driver_terms  # type: ignore[method-assign]
FalkorDriver.build_fulltext_query = build_falkordb_driver_fulltext_query  # type: ignore[method-assign]
falkordb_search_ops.FalkorSearchOperations.node_fulltext_search = _timeout_tolerant_falkordb_node_fulltext_search  # type: ignore[method-assign]
falkordb_search_ops.FalkorSearchOperations.edge_fulltext_search = _timeout_tolerant_falkordb_edge_fulltext_search  # type: ignore[method-assign]


class PersistentMemoryFalkorDriver(FalkorDriver):
    """Graphiti 0.29.2 compatibility for code-formatted memory content.

    Upstream's FalkorDB sanitizer leaves some punctuation intact even though
    RediSearch treats it as full-text query syntax.

    The base driver is patched above so Graphiti's per-project plain-driver
    clones remain protected; this override documents that contract at the
    startup-driver boundary too.
    """

    def sanitize(self, query: str) -> str:
        return sanitize_falkordb_fulltext_terms(query)


def build_driver(s: Settings):
    if s.graph_backend == "neo4j":
        return Neo4jDriver(
            uri=s.neo4j_uri,
            user=s.neo4j_user,
            password=s.neo4j_password,
            database=s.neo4j_database,
        )
    # default: falkordb (container name + INTERNAL port 6379)
    return PersistentMemoryFalkorDriver(
        host=s.falkordb_host,
        port=s.falkordb_port,
        username=s.falkordb_username,
        password=s.falkordb_password,
        database=s.falkordb_database,
    )


# -----------------------------------------------------------------------------
# Usage metrics — report extraction-LLM token usage to the api (Usage page).
#
# graphiti-core's LLM clients don't surface per-call usage, so we wrap the
# UNDERLYING SDK client's create() (whose response carries `.usage`) at
# construction. This depends only on the stable SDK shape (messages.create /
# chat.completions.create + response.usage.*), not on graphiti-core internals, and
# is fully wrapped in try/except so usage capture can NEVER break an extraction.
# Confirm `self.client` exists on the installed graphiti-core clients (0.29.2) — if
# the attribute/path differs, wrapping silently no-ops (logged once) and usage is
# simply not recorded.
# -----------------------------------------------------------------------------
UsagePoster = Callable[[str, int, int], None]
_usage_context: ContextVar[dict[str, Any] | None] = ContextVar("usage_context", default=None)


def set_usage_context(raw: str | None) -> object:
    try:
        value = json.loads(raw) if raw else None
        if not isinstance(value, dict):
            value = None
        elif value:
            value = {**value, "_started_at": time.monotonic()}
    except Exception:
        value = None
    return _usage_context.set(value)


def reset_usage_context(token: object) -> None:
    _usage_context.reset(token)  # type: ignore[arg-type]


def _make_usage_poster(s: Settings) -> UsagePoster:
    """Fire-and-forget POST {api_url}/internal/usage. Best-effort; never raises."""
    async def _post(model: str, tin: int, tout: int) -> None:
        if not (s.usage_ingest_token and s.api_url):
            return
        try:
            async with httpx.AsyncClient(timeout=2.0) as c:
                payload: dict[str, Any] = {"service": "graphiti", "model": model, "tokens_in": int(tin), "tokens_out": int(tout)}
                context = _usage_context.get()
                graph = graph_usage_payload(context)
                if graph:
                    started_at = context.get("_started_at", time.monotonic())
                    graph["duration_ms"] = max(0, int((time.monotonic() - started_at) * 1000))
                    graph["success"] = True
                    payload["graph"] = graph
                await c.post(
                    f"{s.api_url.rstrip('/')}/internal/usage",
                    json=payload,
                    headers={"authorization": f"Bearer {s.usage_ingest_token}"},
                )
        except Exception:
            pass  # best-effort: a metrics POST must never affect extraction

    def post(model: str, tin: int, tout: int) -> None:
        try:
            asyncio.get_running_loop().create_task(_post(model, tin, tout))
        except RuntimeError:
            pass  # no running loop (shouldn't happen in the async request path)

    return post


def _wrap_sdk_create(create, post: UsagePoster, model: str, in_attr: str, out_attr: str):
    async def wrapped(*args, **kwargs):
        resp = await create(*args, **kwargs)
        try:
            u = getattr(resp, "usage", None)
            if u is not None:
                post(model, getattr(u, in_attr, 0) or 0, getattr(u, out_attr, 0) or 0)
        except Exception:
            pass
        return resp

    return wrapped


class UsageTrackingAnthropicClient(AnthropicClient):
    def __init__(self, config: LLMConfig, post: UsagePoster, client: AsyncAnthropic | None = None) -> None:
        super().__init__(config=config, client=client)
        try:
            self.client.messages.create = _wrap_sdk_create(  # type: ignore[method-assign]
                self.client.messages.create, post, config.model, "input_tokens", "output_tokens"
            )
        except Exception as exc:  # pragma: no cover — defensive
            print(f"[usage] could not wrap Anthropic client for usage capture: {exc}")


class UsageTrackingOpenAIClient(OpenAIClient):
    def __init__(self, config: LLMConfig, post: UsagePoster) -> None:
        super().__init__(config=config)
        try:
            self.client.chat.completions.create = _wrap_sdk_create(  # type: ignore[method-assign]
                self.client.chat.completions.create, post, config.model, "prompt_tokens", "completion_tokens"
            )
        except Exception as exc:  # pragma: no cover — defensive
            print(f"[usage] could not wrap OpenAI client for usage capture: {exc}")


# -----------------------------------------------------------------------------
# Extraction LLM — cloud, configurable. Anthropic Sonnet 4.6 by default.
# -----------------------------------------------------------------------------
def build_llm_client(s: Settings):
    post = _make_usage_poster(s)
    if s.extraction_provider == "openai":
        # OpenAI-compatible path. Pass base_url so this also serves a LOCAL
        # Ollama (OPENAI_BASE_URL=http://host:11434/v1, OPENAI_API_KEY=ollama).
        # graphiti-core uses LLMConfig.small_model for cheaper extraction sub-steps;
        # against Ollama it MUST also be a pulled model (else it falls back to
        # gpt-4.1-mini and 404s on Ollama), so pin small_model = extraction_model.
        base_url = s.openai_base_url or None
        return UsageTrackingOpenAIClient(
            LLMConfig(
                model=s.extraction_model,
                small_model=s.extraction_model,
                api_key=s.openai_api_key,
                base_url=base_url,
            ),
            post,
        )
    # default: anthropic
    anthropic_client = AsyncAnthropic(
        **anthropic_client_kwargs(s.anthropic_api_key, max_retries=6),
    )
    return UsageTrackingAnthropicClient(
        LLMConfig(model=s.extraction_model, api_key=s.anthropic_api_key),
        post,
        client=anthropic_client,
    )


# -----------------------------------------------------------------------------
# Embedder — ALWAYS server-side (see config.py note). Ollama by default via its
# OpenAI-compatible /v1 endpoint; OpenAI or Voyage cloud opt-in.
# -----------------------------------------------------------------------------
def build_embedder(s: Settings):
    if s.embed_provider == "voyage":
        # Imported lazily so a FalkorDB+Ollama default deploy needn't resolve the
        # voyage client at import time.
        from graphiti_core.embedder.voyage import VoyageAIEmbedder, VoyageAIEmbedderConfig

        return VoyageAIEmbedder(
            config=VoyageAIEmbedderConfig(
                embedding_model=s.embed_model,
                embedding_dim=s.embed_dim,
                api_key=s.voyage_api_key,
            )
        )

    if s.embed_provider == "openai":
        return OpenAIEmbedder(
            config=OpenAIEmbedderConfig(
                embedding_model=s.embed_model,
                embedding_dim=s.embed_dim,
                api_key=s.openai_api_key,
            )
        )

    # default: ollama — OpenAI-compatible endpoint at <OLLAMA_URL>/v1. api_key is
    # a required-but-ignored placeholder (the SDK demands a non-empty value).
    return OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            embedding_model=s.embed_model,
            embedding_dim=s.embed_dim,
            base_url=f"{s.ollama_url.rstrip('/')}/v1",
            api_key="ollama",
        )
    )


def build_graphiti(s: Settings) -> Graphiti:
    """Construct the singleton. Held on app.state.graphiti, built once in
    lifespan — NOT a per-request dependency (the driver holds a live connection;
    rebuilding per request leaks connections)."""
    return Graphiti(
        graph_driver=build_driver(s),
        llm_client=build_llm_client(s),
        embedder=build_embedder(s),
    )


# -----------------------------------------------------------------------------
# Backend-agnostic temporal reads (back /timeline and /contradictions).
#
# Why raw Cypher instead of graphiti.search(): search() is hybrid relevance
# search capped by num_results — it cannot give a *complete*, deterministically
# ordered fact stream. /timeline and /contradictions are temporal oracles, so
# they MATCH the RELATES_TO edges directly and order by valid_at. Both FalkorDB
# and Neo4j speak Cypher, so one query string serves both backends.
#
# graphiti-core stores entity "fact" edges as :RELATES_TO relationships carrying
# {uuid, name, fact, group_id, created_at, valid_at, invalid_at, expired_at}.
# Driver.execute_query is the confirmed low-level escape hatch on both drivers.
# -----------------------------------------------------------------------------

# All RELATES_TO edges in the given groups, oldest-valid first. The coalesced
# temporal key and UUID form a stable backend-neutral continuation tuple.
_TIMELINE_GROUP_CYPHER = """
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
WITH a, b, r, toString(coalesce(r.valid_at, r.created_at)) AS sort_at
WHERE r.group_id IN $group_ids
  AND ($after_at IS NULL OR sort_at > $after_at
       OR (sort_at = $after_at AND r.uuid > $after_uuid))
RETURN r.uuid AS uuid, r.name AS name, r.fact AS fact,
       a.uuid AS source_node_uuid, b.uuid AS target_node_uuid,
       a.name AS source_name, b.name AS target_name,
       r.group_id AS group_id,
       r.created_at AS created_at, r.valid_at AS valid_at,
       r.invalid_at AS invalid_at, r.expired_at AS expired_at,
       sort_at AS sort_at
ORDER BY sort_at ASC, r.uuid ASC
LIMIT $limit
"""

# Same, but constrained to edges touching one entity node (either endpoint).
_TIMELINE_ENTITY_CYPHER = """
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
WITH a, b, r, toString(coalesce(r.valid_at, r.created_at)) AS sort_at
WHERE r.group_id IN $group_ids
  AND ($entity_uuid IN [a.uuid, b.uuid])
  AND ($after_at IS NULL OR sort_at > $after_at
       OR (sort_at = $after_at AND r.uuid > $after_uuid))
RETURN r.uuid AS uuid, r.name AS name, r.fact AS fact,
       a.uuid AS source_node_uuid, b.uuid AS target_node_uuid,
       a.name AS source_name, b.name AS target_name,
       r.group_id AS group_id,
       r.created_at AS created_at, r.valid_at AS valid_at,
       r.invalid_at AS invalid_at, r.expired_at AS expired_at,
       sort_at AS sort_at
ORDER BY sort_at ASC, r.uuid ASC
LIMIT $limit
"""

# Edges between a specific (source, target) node pair — used to surface what a
# just-written episode superseded (the AddEpisodeResults gap workaround).
_BETWEEN_NODES_CYPHER = """
MATCH (a:Entity {uuid: $source_uuid})-[r:RELATES_TO]->(b:Entity {uuid: $target_uuid})
RETURN r.uuid AS uuid, r.name AS name, r.fact AS fact,
       a.uuid AS source_node_uuid, b.uuid AS target_node_uuid,
       a.name AS source_name, b.name AS target_name,
       r.group_id AS group_id,
       r.created_at AS created_at, r.valid_at AS valid_at,
       r.invalid_at AS invalid_at, r.expired_at AS expired_at
"""


async def _run(graphiti: Graphiti, cypher: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """Execute a read query through the configured driver and normalize the
    result to a list[dict]. execute_query returns a (records, header, summary)
    tuple on graphiti-core's drivers; records may be neo4j Record objects or
    plain dicts depending on backend — coerce to dict either way."""
    result = await graphiti.driver.execute_query(cypher, **params)
    records = result[0] if isinstance(result, tuple) else result
    rows: list[dict[str, Any]] = []
    for rec in records or []:
        rows.append(dict(rec) if not isinstance(rec, dict) else rec)
    return rows


async def fetch_timeline(
    graphiti: Graphiti,
    group_ids: list[str],
    entity_uuid: str | None,
    limit: int,
    after_at: str | None = None,
    after_uuid: str | None = None,
) -> list[dict[str, Any]]:
    params = {
        "group_ids": group_ids,
        "limit": limit,
        "after_at": after_at,
        "after_uuid": after_uuid or "",
    }
    if entity_uuid:
        return await _run(
            graphiti,
            _TIMELINE_ENTITY_CYPHER,
            {**params, "entity_uuid": entity_uuid},
        )
    return await _run(
        graphiti,
        _TIMELINE_GROUP_CYPHER,
        params,
    )


async def fetch_edges_between(
    graphiti: Graphiti, source_uuid: str, target_uuid: str
) -> list[dict[str, Any]]:
    return await _run(
        graphiti,
        _BETWEEN_NODES_CYPHER,
        {"source_uuid": source_uuid, "target_uuid": target_uuid},
    )


# Compatibility bridge for pre-v2 writers that do not yet have the Graphiti
# episode UUID. Graph v2 lifecycle work must use remove_episode_by_uuid instead;
# this helper is removed once all persisted rows have provenance.
_DELETE_LEGACY_EPISODE_CYPHER = """
MATCH (e:Episodic {group_id: $group_id, name: $name})
WITH e, e.uuid AS uuid
DETACH DELETE e
RETURN uuid AS deleted_uuid
"""


async def delete_legacy_episode_by_name(graphiti: Graphiti, group_id: str, name: str) -> int:
    rows = await _run(graphiti, _DELETE_LEGACY_EPISODE_CYPHER, {"group_id": group_id, "name": name})
    return len(rows)


async def purge_legacy_group(graphiti: Graphiti, group_id: str) -> dict[str, int]:
    """Remove a *validated and unread* legacy partition after V2 cutover.

    This deliberately is not used for live memory deletion: that path must use
    Graphiti's provenance-aware remove_episode API. Legacy groups are derived
    cache data only, and removing their group-scoped facts/episodes after the
    Postgres-backed V2 validation cannot affect the new partition.
    """
    before = await _run(graphiti, """
        MATCH (e:Episodic {group_id: $group_id})
        RETURN count(e) AS episodes
    """, {"group_id": group_id})
    facts_before = await _run(graphiti, """
        MATCH ()-[r:RELATES_TO {group_id: $group_id}]->()
        RETURN count(r) AS facts
    """, {"group_id": group_id})
    await _run(graphiti, """
        MATCH ()-[r:RELATES_TO {group_id: $group_id}]->()
        DELETE r
    """, {"group_id": group_id})
    await _run(graphiti, """
        MATCH (e:Episodic {group_id: $group_id})
        DETACH DELETE e
    """, {"group_id": group_id})
    episodes_left = await _run(graphiti, "MATCH (e:Episodic {group_id: $group_id}) RETURN count(e) AS episodes", {"group_id": group_id})
    facts_left = await _run(graphiti, "MATCH ()-[r:RELATES_TO {group_id: $group_id}]->() RETURN count(r) AS facts", {"group_id": group_id})
    if int((episodes_left[0] if episodes_left else {}).get("episodes", 0)) != 0 or int((facts_left[0] if facts_left else {}).get("facts", 0)) != 0:
        raise RuntimeError(f"legacy group {group_id} still has graph data after cleanup")
    return {
        "episodes": int((episodes_left[0] if episodes_left else {}).get("episodes", 0)),
        "facts": int((facts_left[0] if facts_left else {}).get("facts", 0)),
    }

async def find_episode_by_idempotency_key(graphiti: Graphiti, group_id: str, key: str) -> str | None:
    rows = await _run(graphiti, """
        MATCH (e:Episodic {group_id: $group_id, name: $key})
        RETURN e.uuid AS uuid
        LIMIT 1
    """, {"group_id": group_id, "key": key})
    return rows[0].get("uuid") if rows else None
