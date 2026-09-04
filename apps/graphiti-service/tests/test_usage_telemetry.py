from __future__ import annotations

import unittest


class GraphUsageTelemetryContractTest(unittest.TestCase):
    def test_maps_the_typescript_header_shape_to_the_internal_usage_wire_contract(self) -> None:
        from usage_telemetry import graph_usage_payload

        payload = graph_usage_payload({
            "operationId": "11111111-1111-1111-1111-111111111111",
            "subjectKind": "memory",
            "subjectId": "22222222-2222-2222-2222-222222222222",
            "teamId": "33333333-3333-3333-3333-333333333333",
            "project": "benchmark-project",
            "graphGroupId": "pmg2_benchmark",
            "stage": "write",
            "_started_at": 1.0,
        })

        self.assertEqual(payload, {
            "operation_id": "11111111-1111-1111-1111-111111111111",
            "subject_kind": "memory",
            "subject_id": "22222222-2222-2222-2222-222222222222",
            "team_id": "33333333-3333-3333-3333-333333333333",
            "project": "benchmark-project",
            "graph_group_id": "pmg2_benchmark",
            "stage": "write",
        })

    def test_rejects_incomplete_context_instead_of_emitting_an_invalid_request(self) -> None:
        from usage_telemetry import graph_usage_payload

        self.assertIsNone(graph_usage_payload({"operationId": "missing-required-fields"}))
