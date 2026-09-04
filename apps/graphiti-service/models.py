# =============================================================================
# persistent-memory-graphiti — Pydantic request/response models
#
# Stable shapes the TS API/worker code against, independent of the graph backend
# (FalkorDB vs Neo4j) and of graphiti-core internals.
#
# TENANCY CONTRACT (the only isolation boundary at this layer — there is no auth):
#   • WRITES take exactly ONE group_id (= team_id). No array. This is the
#     structural enforcement of "writes never cross teams": there is no request
#     shape that can write to two teams at once.
#   • READS take group_ids: list[str] (= readableTeams = own ∪ granted, computed
#     by the API from identity). min_length=1 so an empty list — which would
#     otherwise search EVERYTHING — is rejected.
# =============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


# -----------------------------------------------------------------------------
# Shared serialized fact edge (graphiti EntityEdge -> stable wire shape).
# fact_embedding is deliberately dropped (large float array, noise).
#
# valid_at / invalid_at = EVENT time (when the fact became / stopped being true
#   in the world). invalid_at NOT NULL  ⇒  the fact was superseded/expired.
# created_at / expired_at = SYSTEM time (when Graphiti learned / un-learned it).
# /timeline and /contradictions filter on invalid_at (event-time), NOT expired_at.
# -----------------------------------------------------------------------------
class FactEdge(BaseModel):
    uuid: str
    name: str | None = None  # relation / predicate type, e.g. "RUNS_ON"
    fact: str | None = None  # natural-language fact text
    source_node_uuid: str | None = None
    target_node_uuid: str | None = None
    source_name: str | None = None
    target_name: str | None = None
    group_id: str | None = None  # = team_id that owns this edge
    created_at: datetime | None = None
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    expired_at: datetime | None = None


# -----------------------------------------------------------------------------
# POST /episodes — the ONLY write. Stamps a single group_id.
# -----------------------------------------------------------------------------
class EpisodeRequest(BaseModel):
    group_id: str = Field(min_length=1)  # = team_id; required, no default, no array
    name: str
    episode_body: str
    source: Literal["text", "message", "json"] = "text"
    source_description: str = ""
    # Event-time of the fact. The temporal lever: a later reference_time on a
    # contradicting episode supersedes the earlier fact. Defaults to now(UTC).
    reference_time: datetime | None = None
    # Backward-compatible only. graphiti-core treats uuid as an existing episode
    # lookup, not a create id, so main.py intentionally ignores it on writes.
    uuid: str | None = None
    # Optional caller-stable key. When supplied, the wrapper finds an existing
    # episode in this group before calling Graphiti, making timeout retries safe.
    idempotency_key: str | None = Field(default=None, min_length=1)


class NodeBrief(BaseModel):
    uuid: str
    name: str | None = None
    labels: list[str] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# DELETE /episodes — provenance-aware removal of one persisted Graphiti episode.
# group_id remains mandatory so callers retain their single-partition contract;
# episode_uuid is the durable provenance returned by POST /episodes.
# -----------------------------------------------------------------------------
class DeleteEpisodeRequest(BaseModel):
    group_id: str = Field(min_length=1)
    episode_uuid: str | None = Field(default=None, min_length=1)
    # Compatibility only for writers that predate persisted episode provenance.
    # Graph v2 writers must send episode_uuid and this field is removed at cutover.
    name: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def exactly_one_identifier(self) -> "DeleteEpisodeRequest":
        if (self.episode_uuid is None) == (self.name is None):
            raise ValueError("provide exactly one of episode_uuid or name")
        return self


class DeleteEpisodeResponse(BaseModel):
    deleted: int = 0


class PurgeGroupRequest(BaseModel):
    group_id: str = Field(min_length=1)


class PurgeGroupResponse(BaseModel):
    episodes: int = 0
    facts: int = 0


class EpisodeImpactRequest(BaseModel):
    group_id: str = Field(min_length=1)
    episode_uuids: list[str] = Field(min_length=1, max_length=200)


class EpisodeImpact(BaseModel):
    episode_uuid: str
    exists: bool
    primary_fact_count: int = 0
    supporting_fact_count: int = 0
    primary_facts: list[dict[str, str | None]] = Field(default_factory=list)


class EpisodeImpactResponse(BaseModel):
    impacts: list[EpisodeImpact] = Field(default_factory=list)


class EpisodeResponse(BaseModel):
    status: str = "accepted"
    episode_uuid: str
    nodes: list[NodeBrief] = Field(default_factory=list)
    edges: list[FactEdge] = Field(default_factory=list)  # facts created THIS call
    # Diagnostic: prior edges this episode superseded (invalid_at now set).
    # Derived via a driver query (graphiti-core 0.29.2 AddEpisodeResults does NOT
    # expose this); empty list is normal when nothing was contradicted.
    invalidated_edges: list[FactEdge] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# POST /search — cross-team fact retrieval (native multi-group fan-out).
# -----------------------------------------------------------------------------
class SearchRequest(BaseModel):
    query: str
    group_ids: list[str] = Field(min_length=1)  # = readableTeams; ≥1 enforced
    limit: int = 10
    center_node_uuid: str | None = None
    # Relevance search returns currently-valid + historical edges. Set true to
    # keep only currently-true facts (invalid_at IS NULL).
    valid_only: bool = False


class SearchResponse(BaseModel):
    facts: list[FactEdge] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# GET /timeline — deterministic chronological fact stream (temporal key + UUID).
# Not relevance-ranked. Each entry carries a derived valid/invalid status.
# -----------------------------------------------------------------------------
class TimelineEntry(FactEdge):
    status: Literal["valid", "invalid"]  # invalid_at IS NULL -> "valid"


class TimelineResponse(BaseModel):
    entity_uuid: str | None = None
    entries: list[TimelineEntry] = Field(default_factory=list)
    next_after_at: str | None = None
    next_after_uuid: str | None = None


# -----------------------------------------------------------------------------
# GET /contradictions — superseded facts (invalid_at NOT NULL), each paired with
# the newer fact that replaced it (same node pair, successor.valid_at ==
# superseded.invalid_at) when one exists.
# -----------------------------------------------------------------------------
class Contradiction(BaseModel):
    superseded: FactEdge  # invalid_at IS NOT NULL
    superseded_by: FactEdge | None = None  # None when the expiry was stated in-text


class ContradictionsResponse(BaseModel):
    contradictions: list[Contradiction] = Field(default_factory=list)


# -----------------------------------------------------------------------------
# GET /healthcheck
# -----------------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: str = "ok"
    backend: str
    embedder: str
    dim: int
