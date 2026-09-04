"""Authentication helpers for graphiti-service LLM clients."""

from __future__ import annotations

OAUTH_BETA_HEADER = "oauth-2025-04-20"


def is_anthropic_oat(token: str | None) -> bool:
    """Return true for Claude setup-token/OAT credentials."""
    return bool(token and "sk-ant-oat" in token)


def anthropic_client_kwargs(token: str | None, *, max_retries: int = 2) -> dict:
    """Build AsyncAnthropic kwargs for API-key or OAT/Bearer credentials.

    graphiti-core passes every Anthropic credential as x-api-key. OAT credentials
    are only accepted as OAuth Bearer tokens with the oauth beta header, matching
    the TypeScript API's Anthropic extraction adapter.
    """
    token = token or ""
    if is_anthropic_oat(token):
        return {
            "api_key": None,
            "auth_token": token,
            "max_retries": max_retries,
            "default_headers": {
                "anthropic-beta": OAUTH_BETA_HEADER,
                "anthropic-dangerous-direct-browser-access": "true",
            },
        }
    return {"api_key": token, "max_retries": max_retries}
