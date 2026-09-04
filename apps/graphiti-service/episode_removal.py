"""Provenance-aware, group-scoped episode removal through Graphiti's API."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from graphiti_core.nodes import EpisodicNode, NodeNotFoundError


class EpisodeRemover(Protocol):
    driver: Any
    llm_client: Any
    embedder: Any
    cross_encoder: Any
    store_raw_episode_content: bool
    max_coroutines: int | None

    async def remove_episode(self, episode_uuid: str) -> None: ...


@dataclass(frozen=True)
class EpisodeImpact:
    """Read-only deletion impact derived from current Graphiti provenance."""

    episode_uuid: str
    exists: bool
    primary_fact_count: int = 0
    supporting_fact_count: int = 0
    primary_facts: list[dict[str, str | None]] = field(default_factory=list)


async def inspect_episode_impact(
    graphiti: EpisodeRemover,
    group_id: str,
    episode_uuid: str,
) -> EpisodeImpact:
    """Return the fact-provenance impact of deleting one episode in one group."""
    driver = graphiti.driver.clone(database=group_id)
    records, _, _ = await driver.execute_query(
        """
        MATCH (episode:Episodic {uuid: $episode_uuid})
        OPTIONAL MATCH (source)-[edge:RELATES_TO]->(target)
        WHERE $episode_uuid IN edge.episodes
        RETURN episode.uuid AS episode_uuid, edge.uuid AS edge_uuid,
               edge.fact AS fact, edge.episodes AS episodes,
               source.name AS source_name, target.name AS target_name
        """,
        episode_uuid=episode_uuid,
    )
    if not records:
        return EpisodeImpact(episode_uuid=episode_uuid, exists=False)

    primary_facts: list[dict[str, str | None]] = []
    supporting_fact_count = 0
    for record in records:
        episodes = record.get("episodes") or []
        if not record.get("edge_uuid"):
            continue
        if episodes and episodes[0] == episode_uuid:
            primary_facts.append({
                "edge_uuid": record.get("edge_uuid"),
                "fact": record.get("fact"),
                "source_name": record.get("source_name"),
                "target_name": record.get("target_name"),
            })
        else:
            supporting_fact_count += 1
    return EpisodeImpact(
        episode_uuid=episode_uuid,
        exists=True,
        primary_fact_count=len(primary_facts),
        supporting_fact_count=supporting_fact_count,
        primary_facts=primary_facts,
    )


async def remove_episode_by_uuid(
    graphiti: EpisodeRemover,
    group_id: str,
    episode_uuid: str,
) -> int:
    """Verify group provenance, then cascade-remove the exact Graphiti episode."""
    # Graphiti maps each group ID to a separate graph database. Do not mutate
    # the singleton: its driver may currently point at a different group.
    scoped = graphiti.__class__(
        graph_driver=graphiti.driver.clone(database=group_id),
        llm_client=graphiti.llm_client,
        embedder=graphiti.embedder,
        cross_encoder=graphiti.cross_encoder,
        store_raw_episode_content=graphiti.store_raw_episode_content,
        max_coroutines=graphiti.max_coroutines,
    )
    try:
        episode = await EpisodicNode.get_by_uuid(scoped.driver, episode_uuid)
    except NodeNotFoundError:
        # A retry may arrive after the first attempt completed but before the
        # lifecycle outbox recorded completion. Deletion is therefore idempotent.
        return 0
    if episode.group_id != group_id:
        raise ValueError(f"episode {episode_uuid} does not belong to group {group_id}")

    # A Falkor driver clone shares the singleton's connection, so it must not be
    # closed here. The process lifespan owns the original driver's shutdown.
    await scoped.remove_episode(episode_uuid)
    return 1
