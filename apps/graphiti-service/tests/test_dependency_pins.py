from __future__ import annotations

from pathlib import Path
import unittest


class GraphitiDependencyPinsTest(unittest.TestCase):
    def test_graph_backend_client_and_redis_are_exactly_pinned(self) -> None:
        """A clean image build must not resolve a later incompatible redis-py."""
        requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
        lines = requirements.read_text(encoding="utf-8").splitlines()
        pins = {
            name.strip().lower(): version.strip()
            for line in lines
            if "==" in line and not line.lstrip().startswith("#")
            for name, version in [line.split("==", 1)]
        }

        self.assertEqual(pins.get("graphiti-core[falkordb,anthropic]"), "0.29.2")
        self.assertEqual(pins.get("anthropic"), "1.3.0")
        self.assertEqual(pins.get("falkordb"), "1.6.2")
        self.assertEqual(pins.get("redis"), "8.0.1")
