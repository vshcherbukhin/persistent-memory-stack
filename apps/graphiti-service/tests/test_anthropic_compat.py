from __future__ import annotations

import unittest

from anthropic_compat import normalize_message_create_kwargs


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
