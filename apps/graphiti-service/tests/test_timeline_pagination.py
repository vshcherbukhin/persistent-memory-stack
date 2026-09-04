from __future__ import annotations

import unittest


class _Driver:
    def __init__(self) -> None:
        self.query = ""
        self.params: dict[str, object] = {}

    async def execute_query(self, query: str, **params: object):
        self.query = query
        self.params = params
        return ([{"uuid": "fact-2"}], None, None)


class _Graphiti:
    def __init__(self) -> None:
        self.driver = _Driver()


class TimelinePaginationContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_uses_stable_time_and_uuid_keyset_for_group_timeline(self) -> None:
        from graph import fetch_timeline

        graphiti = _Graphiti()
        rows = await fetch_timeline(
            graphiti,
            ["group-a"],
            None,
            21,
            "2026-08-31T15:00:00Z",
            "fact-1",
        )

        self.assertEqual(rows, [{"uuid": "fact-2"}])
        self.assertIn("sort_at > $after_at", graphiti.driver.query)
        self.assertIn("sort_at = $after_at AND r.uuid > $after_uuid", graphiti.driver.query)
        self.assertIn("ORDER BY sort_at ASC, r.uuid ASC", graphiti.driver.query)
        self.assertEqual(graphiti.driver.params["after_uuid"], "fact-1")
        self.assertEqual(graphiti.driver.params["limit"], 21)

    async def test_applies_the_same_keyset_to_entity_timeline(self) -> None:
        from graph import fetch_timeline

        graphiti = _Graphiti()
        await fetch_timeline(graphiti, ["group-a"], "entity-1", 10)

        self.assertIn("$entity_uuid IN [a.uuid, b.uuid]", graphiti.driver.query)
        self.assertIn("ORDER BY sort_at ASC, r.uuid ASC", graphiti.driver.query)
        self.assertIsNone(graphiti.driver.params["after_at"])
        self.assertEqual(graphiti.driver.params["after_uuid"], "")
