from __future__ import annotations

import asyncio
from types import SimpleNamespace
import unittest

from anthropic_compat import normalize_message_create_kwargs, wrap_anthropic_message_create


class AnthropicCompatibilityTest(unittest.TestCase):
    def test_removes_sampling_params_dropped_by_anthropic_sdk_1_x(self) -> None:
        original = {
            "model": "claude-haiku-4-5",
            "messages": [{"role": "user", "content": "Extract entities"}],
            "max_tokens": 1024,
            "temperature": 0.0,
            "top_p": 0.9,
            "top_k": 40,
        }

        normalized = normalize_message_create_kwargs(original)

        self.assertEqual(
            normalized,
            {
                "model": "claude-haiku-4-5",
                "messages": [{"role": "user", "content": "Extract entities"}],
                "max_tokens": 1024,
            },
        )
        self.assertIn("temperature", original)

    def test_preserves_supported_anthropic_message_options(self) -> None:
        original = {
            "model": "claude-haiku-4-5",
            "max_tokens": 1024,
            "system": "Return JSON",
            "extra_headers": {"x-example": "value"},
        }

        self.assertEqual(normalize_message_create_kwargs(original), original)

    def test_wrapped_sdk_boundary_normalizes_kwargs_and_preserves_usage(self) -> None:
        received: dict[str, object] = {}
        usage_events: list[tuple[str, int, int]] = []
        response = SimpleNamespace(
            usage=SimpleNamespace(input_tokens=17, output_tokens=5),
        )

        async def create(*_args, **kwargs):
            received.update(kwargs)
            return response

        wrapped = wrap_anthropic_message_create(
            create,
            lambda model, tokens_in, tokens_out: usage_events.append(
                (model, tokens_in, tokens_out)
            ),
            "claude-haiku-4-5",
        )

        result = asyncio.run(
            wrapped(
                model="claude-haiku-4-5",
                max_tokens=1024,
                messages=[{"role": "user", "content": "Extract entities"}],
                system="Return JSON",
                temperature=0.0,
                top_p=0.9,
                top_k=40,
            )
        )

        self.assertIs(result, response)
        self.assertEqual(
            received,
            {
                "model": "claude-haiku-4-5",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": "Extract entities"}],
                "system": "Return JSON",
            },
        )
        self.assertEqual(usage_events, [("claude-haiku-4-5", 17, 5)])
