"""Compatibility helpers for Graphiti calls into the Anthropic Python SDK."""

from __future__ import annotations

from typing import Any


# Anthropic Python SDK 1.x removed these keyword arguments from
# messages.create(). Graphiti 0.29.2 still forwards them, even for current
# models that do not use the sampling controls.
_REMOVED_MESSAGE_SAMPLING_PARAMS = frozenset({"temperature", "top_p", "top_k"})


def normalize_message_create_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Return Anthropic-compatible message kwargs without mutating the caller."""

    return {
        key: value
        for key, value in kwargs.items()
        if key not in _REMOVED_MESSAGE_SAMPLING_PARAMS
    }
