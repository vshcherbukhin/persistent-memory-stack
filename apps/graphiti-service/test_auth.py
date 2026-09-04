import unittest

from auth import anthropic_client_kwargs, is_anthropic_oat


class AnthropicAuthTests(unittest.TestCase):
    def test_api_key_uses_x_api_key_path(self) -> None:
        self.assertFalse(is_anthropic_oat("sk-ant-api03-example"))
        self.assertEqual(
            anthropic_client_kwargs("sk-ant-api03-example", max_retries=6),
            {"api_key": "sk-ant-api03-example", "max_retries": 6},
        )

    def test_oat_uses_bearer_auth_with_oauth_beta(self) -> None:
        kwargs = anthropic_client_kwargs("sk-ant-oat01-example", max_retries=6)

        self.assertTrue(is_anthropic_oat("sk-ant-oat01-example"))
        self.assertIsNone(kwargs["api_key"])
        self.assertEqual(kwargs["auth_token"], "sk-ant-oat01-example")
        self.assertEqual(kwargs["max_retries"], 6)
        self.assertEqual(kwargs["default_headers"]["anthropic-beta"], "oauth-2025-04-20")
        self.assertEqual(
            kwargs["default_headers"]["anthropic-dangerous-direct-browser-access"],
            "true",
        )


if __name__ == "__main__":
    unittest.main()
