"""Dependency-free contracts shared by Graphiti usage telemetry and its tests."""
from __future__ import annotations

from typing import Any


def graph_usage_payload(context: dict[str, Any] | None) -> dict[str, Any] | None:
    """Translate the TypeScript telemetry header to the API wire contract.

    Keep this pure mapping outside the Graphiti service module so its contract
    can be exercised without starting an LLM client, graph driver, or FastAPI.
    """
    if not context:
        return None
    fields = {
        "operation_id": context.get("operationId"),
        "subject_kind": context.get("subjectKind"),
        "subject_id": context.get("subjectId"),
        "team_id": context.get("teamId"),
        "project": context.get("project"),
        "graph_group_id": context.get("graphGroupId"),
        "stage": context.get("stage"),
    }
    if not all(isinstance(value, str) and value for value in fields.values()):
        return None
    return fields
