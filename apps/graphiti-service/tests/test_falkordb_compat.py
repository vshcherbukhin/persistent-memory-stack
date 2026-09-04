from __future__ import annotations

import asyncio
import string
import unittest

from redis.exceptions import ResponseError


class _QueryTimeoutExecutor:
    async def execute_query(self, *_args, **_kwargs):
        raise ResponseError("Query timed out")


class _QueryFailureExecutor:
    async def execute_query(self, *_args, **_kwargs):
        raise ResponseError("syntax error")


class FalkorDbCompatibilityTest(unittest.TestCase):
    def test_sanitizes_backticks_before_building_a_redisearch_filter(self) -> None:
        from graph import PersistentMemoryFalkorDriver

        driver = PersistentMemoryFalkorDriver(falkor_db=object())

        self.assertEqual(
            driver.sanitize("BUG-5136 uses `options.filter` inside a query"),
            "BUG 5136 uses options filter inside a query",
        )

    def test_sanitizes_backticks_in_the_operations_search_path_used_by_episode_extraction(self) -> None:
        import graph  # noqa: F401 - importing installs the FalkorDB compatibility patch
        from graphiti_core.driver.falkordb.operations import search_ops

        query = search_ops._build_falkor_fulltext_query(
            "Node 22 `experimental strip types` rejects runtime properties",
            ["pmg2_example"],
        )

        self.assertNotIn("`", query)

    def test_all_ascii_punctuation_is_removed_from_both_falkordb_fulltext_paths(self) -> None:
        from graph import PersistentMemoryFalkorDriver
        from graphiti_core.driver.falkordb.operations import search_ops

        source = f"Node 22 {string.punctuation} experimental"
        driver = PersistentMemoryFalkorDriver(falkor_db=object())
        self.assertEqual(driver.sanitize(source), "Node 22 experimental")

        cloned = driver.clone("pmg2_project")
        self.assertEqual(cloned.sanitize(source), "Node 22 experimental")
        cloned_query = cloned.build_fulltext_query(source, ["pmg2_project"])
        self.assertEqual(cloned_query.split(") ", 1)[1], "(Node | 22 | experimental)")

        query = search_ops._build_falkor_fulltext_query(source, ["pmg2_example"])
        terms = query.split(") ", 1)[1]
        self.assertEqual(terms, "(Node | 22 | experimental)")
        self.assertFalse(any(char in terms for char in string.punctuation if char not in "|()"))

    def test_caps_fulltext_candidate_terms_without_disabling_the_query(self) -> None:
        from graph import PersistentMemoryFalkorDriver
        from graphiti_core.driver.falkordb.operations import search_ops

        source = " ".join(f"term{index}" for index in range(40))
        query = search_ops._build_falkor_fulltext_query(source, ["pmg2_example"])
        direct_query = PersistentMemoryFalkorDriver(falkor_db=object()).build_fulltext_query(
            source, ["pmg2_example"]
        )

        terms = query.split(") ", 1)[1].strip("()").split(" | ")
        self.assertEqual(len(terms), 12)
        self.assertEqual(terms, [f"term{index}" for index in range(12)])
        self.assertEqual(direct_query.split(") ", 1)[1], query.split(") ", 1)[1])

    def test_fulltext_timeout_returns_an_empty_optional_candidate_set(self) -> None:
        import graph  # noqa: F401 - importing installs the FalkorDB compatibility patch
        from graphiti_core.driver.falkordb.operations.search_ops import FalkorSearchOperations
        from graphiti_core.search.search_filters import SearchFilters

        async def run() -> tuple[list[object], list[object]]:
            ops = FalkorSearchOperations()
            node_results = await ops.node_fulltext_search(
                _QueryTimeoutExecutor(), "persistent memory graph", SearchFilters(), ["pmg2_example"]
            )
            edge_results = await ops.edge_fulltext_search(
                _QueryTimeoutExecutor(), "persistent memory graph", SearchFilters(), ["pmg2_example"]
            )
            return node_results, edge_results

        self.assertEqual(asyncio.run(run()), ([], []))

    def test_fulltext_fallback_does_not_hide_non_timeout_database_errors(self) -> None:
        import graph  # noqa: F401 - importing installs the FalkorDB compatibility patch
        from graphiti_core.driver.falkordb.operations.search_ops import FalkorSearchOperations
        from graphiti_core.search.search_filters import SearchFilters

        async def run() -> list[object]:
            return await FalkorSearchOperations().edge_fulltext_search(
                _QueryFailureExecutor(), "persistent memory graph", SearchFilters(), ["pmg2_example"]
            )

        with self.assertRaisesRegex(ResponseError, "syntax error"):
            asyncio.run(run())
