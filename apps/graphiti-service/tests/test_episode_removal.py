from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


class _Driver:
    def __init__(self, database: str = "default", calls: list[tuple[str, str]] | None = None, query_result=None) -> None:
        self.database = database
        self.calls = calls if calls is not None else []
        self.query_result = query_result

    def clone(self, *, database: str) -> "_Driver":
        return _Driver(database, self.calls, self.query_result)

    async def execute_query(self, _query: str, **_params: object):
        return self.query_result or ([], None, None)


class _Graphiti:
    def __init__(
        self,
        *,
        graph_driver: _Driver | None = None,
        calls: list[tuple[str, str]] | None = None,
        **_kwargs: object,
    ) -> None:
        self.driver = graph_driver or _Driver(calls=calls)
        self.llm_client = object()
        self.embedder = object()
        self.cross_encoder = object()
        self.store_raw_episode_content = True
        self.max_coroutines = None
        self.calls = self.driver.calls

    async def remove_episode(self, episode_uuid: str) -> None:
        self.calls.append((self.driver.database, episode_uuid))


class EpisodeRemovalContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_removes_the_exact_episode_uuid_through_graphiti(self) -> None:
        from episode_removal import EpisodicNode, remove_episode_by_uuid

        calls: list[tuple[str, str]] = []
        with patch.object(
            EpisodicNode,
            "get_by_uuid",
            new=AsyncMock(return_value=SimpleNamespace(group_id="project-group-1")),
        ):
            removed = await remove_episode_by_uuid(
                _Graphiti(calls=calls), "project-group-1", "episode-1"
            )

        self.assertEqual(removed, 1)
        self.assertEqual(calls, [("project-group-1", "episode-1")])

    async def test_rejects_an_episode_from_a_different_group_before_removal(self) -> None:
        from episode_removal import EpisodicNode, remove_episode_by_uuid

        graphiti = _Graphiti()

        with patch.object(
            EpisodicNode,
            "get_by_uuid",
            new=AsyncMock(return_value=SimpleNamespace(group_id="another-project-group")),
        ):
            with self.assertRaisesRegex(ValueError, "does not belong to group"):
                await remove_episode_by_uuid(graphiti, "project-group-1", "episode-1")

        self.assertEqual(graphiti.calls, [])

    async def test_treats_an_already_removed_episode_as_complete(self) -> None:
        from episode_removal import EpisodicNode, NodeNotFoundError, remove_episode_by_uuid

        graphiti = _Graphiti()

        with patch.object(
            EpisodicNode,
            "get_by_uuid",
            new=AsyncMock(side_effect=NodeNotFoundError("episode-1")),
        ):
            removed = await remove_episode_by_uuid(graphiti, "project-group-1", "episode-1")

        self.assertEqual(removed, 0)
        self.assertEqual(graphiti.calls, [])

    async def test_reports_primary_and_supporting_facts_from_the_requested_group(self) -> None:
        from episode_removal import inspect_episode_impact

        graphiti = _Graphiti()
        graphiti.driver.query_result = ([
            {
                "edge_uuid": "fact-primary",
                "fact": "primary fact",
                "episodes": ["episode-1", "episode-2"],
                "source_name": "source",
                "target_name": "target",
            },
            {
                "edge_uuid": "fact-supporting",
                "fact": "supporting fact",
                "episodes": ["episode-2", "episode-1"],
                "source_name": "source",
                "target_name": "target",
            },
        ], None, None)

        impact = await inspect_episode_impact(graphiti, "project-group-1", "episode-1")

        self.assertEqual(impact.primary_fact_count, 1)
        self.assertEqual(impact.supporting_fact_count, 1)
        self.assertEqual(impact.primary_facts[0]["edge_uuid"], "fact-primary")
