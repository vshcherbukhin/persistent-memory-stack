"""Run in the built image: python -m unittest test_offline_analyzer -v."""
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

from main import app


class OfflineAnalyzerTests(unittest.TestCase):
    def test_first_scan_uses_bundled_suffixes_without_network_and_keeps_detection(self):
        with patch("requests.sessions.Session.request", side_effect=AssertionError("unexpected suffix download")), TestClient(app) as client:
            analyzer = app.state.analyzer
            results = analyzer.analyze(text="Contact synthetic.person@example.com for this fixture.", language="en", entities=["EMAIL_ADDRESS"])
            self.assertTrue(any(result.entity_type == "EMAIL_ADDRESS" for result in results))
            self.assertFalse(analyzer.analyze(text="Ordinary fixture text without private data.", language="en", entities=["EMAIL_ADDRESS"]))
            health = client.get("/healthcheck")
            self.assertEqual(health.status_code, 200)
            self.assertTrue(health.json()["analyzer_ready"])
            self.assertIn("8.30.1", health.json()["gitleaks"])
            response = client.post("/scan", json={"text": "Contact synthetic.person@example.com"})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()["block"])
            self.assertTrue(response.json()["pii"])
            self.assertNotIn("synthetic.person", response.text)
            clean_response = client.post("/scan", json={"text": "Ordinary fixture text without private data."})
            self.assertEqual(clean_response.status_code, 200)
            self.assertFalse(clean_response.json()["block"])
            # Key-shaped base64 of ordinary fixture prose, never a real key.
            payload = "VGhpcyBpcyBhIHN5bnRoZXRpYyBmaXh0dXJl" * 8
            secret_response = client.post("/scan", json={"text": f"-----BEGIN RSA PRIVATE KEY-----\n{payload}\n-----END RSA PRIVATE KEY-----"})
            self.assertEqual(secret_response.status_code, 200)
            self.assertTrue(secret_response.json()["block"])
            self.assertTrue(secret_response.json()["secrets"])
            self.assertNotIn(payload, secret_response.text)
            with patch("main.subprocess.run", side_effect=FileNotFoundError("synthetic missing detector")):
                self.assertEqual(client.post("/scan", json={"text": "Ordinary fixture text"}).status_code, 500)

    def test_scanner_still_fails_closed_when_secret_detector_cannot_run(self):
        from fastapi import HTTPException
        from main import scan_secrets
        with patch("main.subprocess.run", side_effect=FileNotFoundError("synthetic missing detector")):
            with self.assertRaises(HTTPException) as raised:
                scan_secrets("Ordinary fixture text")
            self.assertEqual(raised.exception.status_code, 500)


if __name__ == "__main__":
    unittest.main()
