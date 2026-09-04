"""Disposable FalkorDB proof for Graphiti's episode-delete cascade."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from uuid import uuid4

from graphiti_core import Graphiti
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode

from episode_removal import remove_episode_by_uuid


class _GraphitiRemovalHarness:
    """Runs Graphiti's real removal method without configuring inference clients."""

    def __init__(
        self,
        driver: FalkorDriver | None = None,
        *,
        graph_driver: FalkorDriver | None = None,
        **_kwargs: object,
    ) -> None:
        self.driver = graph_driver or driver
        assert self.driver is not None
        self.llm_client = object()
        self.embedder = object()
        self.cross_encoder = object()
        self.store_raw_episode_content = True
        self.max_coroutines = None

    async def remove_episode(self, episode_uuid: str) -> None:
        await Graphiti.remove_episode(self, episode_uuid)  # type: ignore[arg-type]


@unittest.skipUnless(
    os.getenv("GRAPHITI_INTEGRATION_FALKOR_HOST"),
    "requires a disposable FalkorDB fixture",
)
class EpisodeRemovalIntegrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_removal_cascades_primary_fact_and_orphaned_entities(self) -> None:
        suffix = uuid4().hex
        group_id = f"phase1-delete-{suffix}"
        now = datetime.now(timezone.utc)
        root_driver = FalkorDriver(
            host=os.environ["GRAPHITI_INTEGRATION_FALKOR_HOST"],
            port=int(os.getenv("GRAPHITI_INTEGRATION_FALKOR_PORT", "6379")),
            database=os.getenv("GRAPHITI_INTEGRATION_FALKOR_DATABASE", "default"),
        )
        driver = root_driver.clone(database=group_id)
        graphiti = _GraphitiRemovalHarness(root_driver)

        source = EntityNode(
            uuid=str(uuid4()),
            name=f"source-{suffix}",
            group_id=group_id,
            labels=["TestEntity"],
            name_embedding=[0.0, 0.0],
        )
        target = EntityNode(
            uuid=str(uuid4()),
            name=f"target-{suffix}",
            group_id=group_id,
            labels=["TestEntity"],
            name_embedding=[0.0, 0.0],
        )
        episode = EpisodicNode(
            uuid=str(uuid4()),
            name=f"episode-{suffix}",
            group_id=group_id,
            source=EpisodeType.text,
            source_description="phase-1 deletion fixture",
            content="The source relates to the target.",
            valid_at=now,
        )
        edge = EntityEdge(
            uuid=str(uuid4()),
            group_id=group_id,
            source_node_uuid=source.uuid,
            target_node_uuid=target.uuid,
            created_at=now,
            name="RELATES_TO",
            fact="The source relates to the target.",
            fact_embedding=[0.0, 0.0],
            episodes=[episode.uuid],
            valid_at=now,
            reference_time=now,
        )
        episode.entity_edges = [edge.uuid]

        try:
            await source.save(driver)
            await target.save(driver)
            await episode.save(driver)
            await edge.save(driver)
            for entity_id in (source.uuid, target.uuid):
                await driver.execute_query(
                    "MATCH (e:Episodic {uuid: $episode_uuid}), (n:Entity {uuid: $entity_uuid}) "
                    "CREATE (e)-[:MENTIONS]->(n)",
                    episode_uuid=episode.uuid,
                    entity_uuid=entity_id,
                )

            removed = await remove_episode_by_uuid(graphiti, group_id, episode.uuid)

            self.assertEqual(removed, 1)
            self.assertEqual(await self._count(driver, "MATCH (e:Episodic {uuid: $uuid}) RETURN count(e) AS count", episode.uuid), 0)
            self.assertEqual(await self._count(driver, "MATCH ()-[e:RELATES_TO {uuid: $uuid}]->() RETURN count(e) AS count", edge.uuid), 0)
            self.assertEqual(await self._count(driver, "MATCH (n:Entity {uuid: $uuid}) RETURN count(n) AS count", source.uuid), 0)
            self.assertEqual(await self._count(driver, "MATCH (n:Entity {uuid: $uuid}) RETURN count(n) AS count", target.uuid), 0)
        finally:
            await root_driver.close()

    async def test_removal_of_non_primary_episode_keeps_the_primary_fact(self) -> None:
        suffix = uuid4().hex
        group_id = f"phase1-non-primary-{suffix}"
        now = datetime.now(timezone.utc)
        root_driver = FalkorDriver(
            host=os.environ["GRAPHITI_INTEGRATION_FALKOR_HOST"],
            port=int(os.getenv("GRAPHITI_INTEGRATION_FALKOR_PORT", "6379")),
            database=os.getenv("GRAPHITI_INTEGRATION_FALKOR_DATABASE", "default"),
        )
        driver = root_driver.clone(database=group_id)
        graphiti = _GraphitiRemovalHarness(root_driver)
        source = EntityNode(
            uuid=str(uuid4()),
            name=f"source-{suffix}",
            group_id=group_id,
            labels=["TestEntity"],
            name_embedding=[0.0, 0.0],
        )
        target = EntityNode(
            uuid=str(uuid4()),
            name=f"target-{suffix}",
            group_id=group_id,
            labels=["TestEntity"],
            name_embedding=[0.0, 0.0],
        )
        primary = EpisodicNode(
            uuid=str(uuid4()),
            name=f"primary-{suffix}",
            group_id=group_id,
            source=EpisodeType.text,
            source_description="phase-1 non-primary fixture",
            content="The source relates to the target.",
            valid_at=now,
        )
        non_primary = EpisodicNode(
            uuid=str(uuid4()),
            name=f"non-primary-{suffix}",
            group_id=group_id,
            source=EpisodeType.text,
            source_description="phase-1 non-primary fixture",
            content="The source relates to the target.",
            valid_at=now,
        )
        edge = EntityEdge(
            uuid=str(uuid4()),
            group_id=group_id,
            source_node_uuid=source.uuid,
            target_node_uuid=target.uuid,
            created_at=now,
            name="RELATES_TO",
            fact="The source relates to the target.",
            fact_embedding=[0.0, 0.0],
            episodes=[primary.uuid, non_primary.uuid],
            valid_at=now,
            reference_time=now,
        )
        primary.entity_edges = [edge.uuid]
        non_primary.entity_edges = [edge.uuid]

        try:
            await source.save(driver)
            await target.save(driver)
            await primary.save(driver)
            await non_primary.save(driver)
            await edge.save(driver)
            for episode_id in (primary.uuid, non_primary.uuid):
                for entity_id in (source.uuid, target.uuid):
                    await driver.execute_query(
                        "MATCH (e:Episodic {uuid: $episode_uuid}), (n:Entity {uuid: $entity_uuid}) "
                        "CREATE (e)-[:MENTIONS]->(n)",
                        episode_uuid=episode_id,
                        entity_uuid=entity_id,
                    )

            removed = await remove_episode_by_uuid(graphiti, group_id, non_primary.uuid)

            self.assertEqual(removed, 1)
            self.assertEqual(await self._count(driver, "MATCH (e:Episodic {uuid: $uuid}) RETURN count(e) AS count", non_primary.uuid), 0)
            self.assertEqual(await self._count(driver, "MATCH (e:Episodic {uuid: $uuid}) RETURN count(e) AS count", primary.uuid), 1)
            self.assertEqual(await self._count(driver, "MATCH ()-[e:RELATES_TO {uuid: $uuid}]->() RETURN count(e) AS count", edge.uuid), 1)
            self.assertEqual(await self._count(driver, "MATCH (n:Entity {uuid: $uuid}) RETURN count(n) AS count", source.uuid), 1)
            self.assertEqual(await self._count(driver, "MATCH (n:Entity {uuid: $uuid}) RETURN count(n) AS count", target.uuid), 1)
        finally:
            await root_driver.close()

    @staticmethod
    async def _count(driver: FalkorDriver, query: str, uuid: str) -> int:
        rows, _, _ = await driver.execute_query(query, uuid=uuid)
        return int(rows[0]["count"])
