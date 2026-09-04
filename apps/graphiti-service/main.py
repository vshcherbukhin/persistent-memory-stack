# =============================================================================
# persistent-memory-graphiti — FastAPI app (Phase 4)
#
# API-trusted temporal-graph microservice. Intended callers are the TS api/worker
# over the private compose network; Compose also publishes loopback-only docs for
# local operators. Does NO auth — it trusts every group_id the API passes (the API
# is the choke-point that derives readableTeams from identity and supplies them
# as group_ids). group_id == team_id.
#
# Endpoint surface:
#   GET  /healthcheck      — liveness (matches the compose probe on :8100)
#   POST /episodes         — add_episode; stamps one group_id (writes single-team)
#   POST /search           — search(group_ids=[...]); native cross-team fan-out
#   GET  /timeline         — facts ordered by valid_at (validity windows)
#   GET  /contradictions   — superseded facts (invalid_at NOT NULL) + successors
#
# Run: uvicorn main:app --host 0.0.0.0 --port 8100   (port pinned in Dockerfile;
# upstream graph_service defaults to 8000 — do NOT inherit that).
# =============================================================================
from __future__ import annotations

import os
import logging
import asyncio
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone

# --- SEMAPHORE_LIMIT must be in the process env BEFORE graphiti_core is imported
# anywhere that reads it (graphiti_core reads it once at import/init to size its
# concurrency semaphore). Set it from Settings as the very first thing. -------
from config import get_settings  # noqa: E402

_settings = get_settings()
os.environ.setdefault("SEMAPHORE_LIMIT", str(_settings.semaphore_limit))

from fastapi import Depends, FastAPI, HTTPException, Query, Request  # noqa: E402
from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.nodes import EpisodeType  # noqa: E402

from graph import (  # noqa: E402
    build_graphiti,
    delete_legacy_episode_by_name,
    find_episode_by_idempotency_key,
    fetch_edges_between,
    fetch_timeline,
    purge_legacy_group,
    reset_usage_context,
    set_usage_context,
)
from episode_removal import inspect_episode_impact, remove_episode_by_uuid  # noqa: E402
from models import (  # noqa: E402
    Contradiction,
    ContradictionsResponse,
    DeleteEpisodeRequest,
    DeleteEpisodeResponse,
    EpisodeImpact as EpisodeImpactModel,
    EpisodeImpactRequest,
    EpisodeImpactResponse,
    EpisodeRequest,
    EpisodeResponse,
    PurgeGroupRequest,
    PurgeGroupResponse,
    FactEdge,
    HealthResponse,
    NodeBrief,
    SearchRequest,
    SearchResponse,
    TimelineEntry,
    TimelineResponse,
)

_SOURCE_MAP = {
    "text": EpisodeType.text,
    "message": EpisodeType.message,
    "json": EpisodeType.json,
}
logger = logging.getLogger("persistent_memory.graphiti")
_idempotency_locks: dict[tuple[str, str], asyncio.Lock] = {}


# -----------------------------------------------------------------------------
# Lifespan — build the singleton once, create indices/constraints (idempotent),
# close the driver on shutdown.
# -----------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    graphiti = build_graphiti(s)
    # Idempotent: safe every boot; on the first run against an empty graph it
    # creates the indices/constraints graphiti-core relies on.
    await graphiti.build_indices_and_constraints()
    app.state.graphiti = graphiti
    app.state.settings = s
    try:
        yield
    finally:
        # Release the driver connection (redis for FalkorDB, bolt for Neo4j).
        await graphiti.close()


app = FastAPI(title="persistent-memory-graphiti", version="1.0.0", lifespan=lifespan)


def get_graphiti(request: Request) -> Graphiti:
    """FastAPI dependency: the process-singleton built in lifespan."""
    return request.app.state.graphiti


# -----------------------------------------------------------------------------
# Serialization helpers — graphiti EntityEdge / Cypher row -> FactEdge.
# fact_embedding is never serialized.
# -----------------------------------------------------------------------------
def _coerce_dt(value) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    # Neo4j/FalkorDB temporal scalars stringify to ISO-8601; let pydantic parse.
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    # neo4j.time.DateTime exposes to_native(); fall back gracefully.
    to_native = getattr(value, "to_native", None)
    if callable(to_native):
        native = to_native()
        return native if isinstance(native, datetime) else None
    return None


def _edge_to_fact(e) -> FactEdge:
    """From a graphiti_core EntityEdge object (POST /episodes, /search)."""
    return FactEdge(
        uuid=e.uuid,
        name=getattr(e, "name", None),
        fact=getattr(e, "fact", None),
        source_node_uuid=getattr(e, "source_node_uuid", None),
        target_node_uuid=getattr(e, "target_node_uuid", None),
        group_id=getattr(e, "group_id", None),
        created_at=getattr(e, "created_at", None),
        valid_at=getattr(e, "valid_at", None),
        invalid_at=getattr(e, "invalid_at", None),
        expired_at=getattr(e, "expired_at", None),
    )


def _row_to_fact(r: dict) -> FactEdge:
    """From a Cypher result row dict (/timeline, /contradictions, between-nodes)."""
    return FactEdge(
        uuid=r["uuid"],
        name=r.get("name"),
        fact=r.get("fact"),
        source_node_uuid=r.get("source_node_uuid"),
        target_node_uuid=r.get("target_node_uuid"),
        source_name=r.get("source_name"),
        target_name=r.get("target_name"),
        group_id=r.get("group_id"),
        created_at=_coerce_dt(r.get("created_at")),
        valid_at=_coerce_dt(r.get("valid_at")),
        invalid_at=_coerce_dt(r.get("invalid_at")),
        expired_at=_coerce_dt(r.get("expired_at")),
    )


# =============================================================================
# GET /healthcheck — no auth, no graph round-trip. Matches the compose probe.
# =============================================================================
@app.get("/healthcheck", response_model=HealthResponse)
async def healthcheck(request: Request) -> HealthResponse:
    s = request.app.state.settings
    return HealthResponse(
        backend=s.graph_backend,
        embedder=s.embedder_label(),
        dim=s.embed_dim,
    )


# =============================================================================
# POST /episodes — add_episode; stamps exactly ONE group_id (single-team write).
#
# Synchronous (await) for Phase 4: simpler + directly testable. add_episode is
# heavy (LLM extraction + embedding), so the calling API should set a generous
# client timeout. The upstream asyncio-queue 202 pattern is a deferred latency
# optimization — see README "Synchronous vs. queued ingest".
# =============================================================================
@app.post("/episodes", status_code=202, response_model=EpisodeResponse)
async def add_episode(req: EpisodeRequest, request: Request, graphiti: Graphiti = Depends(get_graphiti)) -> EpisodeResponse:
    # Coerce reference_time to tz-aware UTC: graphiti-core compares datetimes, and
    # naive datetimes misbehave against the stored tz-aware timestamps.
    ref = req.reference_time or datetime.now(timezone.utc)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)

    key_lock: asyncio.Lock | None = None
    if req.idempotency_key:
        # One service process owns each Graphiti partition. Serializing the
        # lookup+add closes the timeout/retry window where two requests could
        # otherwise both observe no Episodic node and add duplicate episodes.
        key_lock = _idempotency_locks.setdefault((req.group_id, req.idempotency_key), asyncio.Lock())
        await key_lock.acquire()
        try:
            existing_uuid = await find_episode_by_idempotency_key(graphiti, req.group_id, req.idempotency_key)
        except Exception:
            key_lock.release()
            raise
        if existing_uuid:
            key_lock.release()
            return EpisodeResponse(episode_uuid=existing_uuid)

    usage_token = set_usage_context(request.headers.get("x-pm-graph-telemetry"))
    try:
        result = await graphiti.add_episode(
            # The key becomes the persisted episode name only for idempotent
            # callers; normal memory history keeps its readable episode name.
            name=req.idempotency_key or req.name,
            episode_body=req.episode_body,
            source=_SOURCE_MAP.get(req.source, EpisodeType.text),
            source_description=req.source_description,
            reference_time=ref,
            group_id=req.group_id,  # the partition key; writes never cross teams
            # graphiti-core 0.29.2 treats `uuid` as "load an existing episode",
            # not "create with this deterministic id"; forwarding a new UUID
            # raises NodeNotFoundError and leaves FalkorDB empty.
            uuid=None,
        )
    except Exception as exc:  # noqa: BLE001 — surface extraction/LLM/driver errors
        logger.exception("graphiti add_episode failed")
        raise HTTPException(status_code=502, detail=f"add_episode failed: {exc}") from exc
    finally:
        reset_usage_context(usage_token)
        if key_lock is not None and key_lock.locked():
            key_lock.release()

    nodes = [
        NodeBrief(uuid=n.uuid, name=getattr(n, "name", None), labels=list(getattr(n, "labels", []) or []))
        for n in result.nodes
    ]
    created_edges = [_edge_to_fact(e) for e in result.edges]

    # Diagnostic — what did this episode supersede? graphiti-core 0.29.2's
    # AddEpisodeResults has no invalidated_edges field, so re-fetch the edges
    # between each touched node pair and keep those whose invalid_at is now set.
    # Best-effort: a driver hiccup here must not fail an otherwise-successful write.
    invalidated: list[FactEdge] = []
    seen: set[str] = set()
    try:
        pairs = {
            (e.source_node_uuid, e.target_node_uuid)
            for e in result.edges
            if getattr(e, "source_node_uuid", None) and getattr(e, "target_node_uuid", None)
        }
        created_uuids = {e.uuid for e in result.edges}
        for src, tgt in pairs:
            for row in await fetch_edges_between(graphiti, src, tgt):
                inv = _coerce_dt(row.get("invalid_at"))
                if inv is not None and row["uuid"] not in created_uuids and row["uuid"] not in seen:
                    seen.add(row["uuid"])
                    invalidated.append(_row_to_fact(row))
    except Exception:  # noqa: BLE001 — diagnostic only; never fail the write on it
        logger.warning("graphiti invalidated-edge diagnostic failed", exc_info=True)
        invalidated = []

    return EpisodeResponse(
        episode_uuid=result.episode.uuid,
        nodes=nodes,
        edges=created_edges,
        invalidated_edges=invalidated,
    )


# =============================================================================
# DELETE /episodes — remove exactly one persisted Graphiti episode through the
# supported API. The Graph-v2 lifecycle/reconciliation worker proves the final
# search invariant after each destructive operation.
# =============================================================================
@app.delete("/episodes", response_model=DeleteEpisodeResponse)
async def delete_episode(
    req: DeleteEpisodeRequest, graphiti: Graphiti = Depends(get_graphiti)
) -> DeleteEpisodeResponse:
    try:
        if req.episode_uuid is not None:
            deleted = await remove_episode_by_uuid(graphiti, req.group_id, req.episode_uuid)
        else:
            # Legacy compatibility only; no Graph v2 writer may call this path.
            deleted = await delete_legacy_episode_by_name(graphiti, req.group_id, req.name or "")
    except Exception as exc:  # noqa: BLE001 — surface driver errors as 502
        logger.exception("graphiti delete_episode failed")
        raise HTTPException(status_code=502, detail=f"delete_episode failed: {exc}") from exc
    return DeleteEpisodeResponse(deleted=deleted)


@app.delete("/groups", response_model=PurgeGroupResponse)
async def purge_group(req: PurgeGroupRequest, graphiti: Graphiti = Depends(get_graphiti)) -> PurgeGroupResponse:
    """Installer-only removal of a validated legacy group; never a live-delete API."""
    try:
        return PurgeGroupResponse(**(await purge_legacy_group(graphiti, req.group_id)))
    except Exception as exc:  # noqa: BLE001
        logger.exception("graphiti purge_group failed")
        raise HTTPException(status_code=502, detail=f"purge_group failed: {exc}") from exc


@app.post("/episodes/impact", response_model=EpisodeImpactResponse)
async def episode_impact(
    req: EpisodeImpactRequest, graphiti: Graphiti = Depends(get_graphiti)
) -> EpisodeImpactResponse:
    """Read current deletion provenance for a bounded set of one-group episodes."""
    try:
        impacts = [
            await inspect_episode_impact(graphiti, req.group_id, episode_uuid)
            for episode_uuid in req.episode_uuids
        ]
    except Exception as exc:  # noqa: BLE001
        logger.exception("graphiti episode impact failed")
        raise HTTPException(status_code=502, detail=f"episode impact failed: {exc}") from exc
    return EpisodeImpactResponse(
        impacts=[
            EpisodeImpactModel(
                episode_uuid=impact.episode_uuid,
                exists=impact.exists,
                primary_fact_count=impact.primary_fact_count,
                supporting_fact_count=impact.supporting_fact_count,
                primary_facts=impact.primary_facts,
            )
            for impact in impacts
        ]
    )


# =============================================================================
# POST /search — search(group_ids=[...]); native multi-team fan-out in ONE call.
# group_ids = readableTeams (own ∪ granted), supplied by the API. The service
# does NOT decide visibility — it trusts the list. Each FactEdge carries its
# group_id so the API can label own-primary vs granted-secondary on merge.
# =============================================================================
@app.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest, graphiti: Graphiti = Depends(get_graphiti)) -> SearchResponse:
    try:
        edges = await graphiti.search(
            query=req.query,
            group_ids=req.group_ids,
            center_node_uuid=req.center_node_uuid,
            num_results=req.limit,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("graphiti search failed")
        raise HTTPException(status_code=502, detail=f"search failed: {exc}") from exc

    facts = [_edge_to_fact(e) for e in edges]
    if req.valid_only:
        facts = [f for f in facts if f.invalid_at is None]
    return SearchResponse(facts=facts)


# =============================================================================
# GET /timeline — deterministic chronological fact stream (temporal key + UUID).
# Driver-level Cypher (not relevance search) so the stream is complete + ordered.
# Scope: one entity (entity_uuid) or whole group(s). group_ids = readableTeams.
# =============================================================================
@app.get("/timeline", response_model=TimelineResponse)
async def timeline(
    group_ids: list[str] = Query(..., min_length=1),
    entity_uuid: str | None = Query(default=None),
    include_invalid: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=1000),
    after_at: str | None = Query(default=None),
    after_uuid: str | None = Query(default=None),
    graphiti: Graphiti = Depends(get_graphiti),
) -> TimelineResponse:
    try:
        rows = await fetch_timeline(
            graphiti, group_ids, entity_uuid, limit + 1, after_at, after_uuid
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("graphiti timeline failed")
        raise HTTPException(status_code=502, detail=f"timeline failed: {exc}") from exc

    page = rows[:limit]
    entries: list[TimelineEntry] = []
    for r in page:
        fact = _row_to_fact(r)
        if not include_invalid and fact.invalid_at is not None:
            continue
        entries.append(
            TimelineEntry(
                **fact.model_dump(),
                status="valid" if fact.invalid_at is None else "invalid",
            )
        )
    has_more = len(rows) > limit
    last = page[-1] if has_more and page else None
    return TimelineResponse(
        entity_uuid=entity_uuid,
        entries=entries,
        next_after_at=str(last["sort_at"]) if last else None,
        next_after_uuid=str(last["uuid"]) if last else None,
    )


# =============================================================================
# GET /contradictions — superseded facts (invalid_at NOT NULL), each paired with
# its successor on the same (source,target) node pair (successor.valid_at ==
# superseded.invalid_at). superseded_by is None when the expiry was stated
# directly in the episode text (no replacing fact).
# =============================================================================
@app.get("/contradictions", response_model=ContradictionsResponse)
async def contradictions(
    group_ids: list[str] = Query(..., min_length=1),
    entity_uuid: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    graphiti: Graphiti = Depends(get_graphiti),
) -> ContradictionsResponse:
    try:
        # Pull the full (ordered) edge set, then derive contradictions in-service.
        rows = await fetch_timeline(graphiti, group_ids, entity_uuid, limit)
    except Exception as exc:  # noqa: BLE001
        logger.exception("graphiti contradictions failed")
        raise HTTPException(status_code=502, detail=f"contradictions failed: {exc}") from exc

    facts = [_row_to_fact(r) for r in rows]

    # Index successors by (source,target) node pair for the pairing step.
    by_pair: dict[tuple[str | None, str | None], list[FactEdge]] = defaultdict(list)
    for f in facts:
        by_pair[(f.source_node_uuid, f.target_node_uuid)].append(f)

    out: list[Contradiction] = []
    for f in facts:
        if f.invalid_at is None:
            continue
        successor = next(
            (
                c
                for c in by_pair[(f.source_node_uuid, f.target_node_uuid)]
                if c.uuid != f.uuid and c.valid_at is not None and c.valid_at == f.invalid_at
            ),
            None,
        )
        out.append(Contradiction(superseded=f, superseded_by=successor))

    return ContradictionsResponse(contradictions=out)
