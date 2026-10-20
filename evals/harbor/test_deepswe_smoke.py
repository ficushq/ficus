import unittest

from deepswe_network_smoke import probe_origin


class ProbeAddressTests(unittest.TestCase):
    def test_accepts_allocated_ports_without_a_fixed_port(self):
        for port in (12345, 54321):
            self.assertEqual(
                probe_origin(f"http://host.docker.internal:{port}/v1/"),
                f"http://host.docker.internal:{port}",
            )

    def test_rejects_unrelated_hosts_credentials_and_ambiguous_urls(self):
        for value in (
            None,
            "https://example.com:12345/v1",
            "http://host.docker.internal/v1",
            "http://host.docker.internal:0/v1",
            "http://secret@host.docker.internal:12345/v1",
            "http://host.docker.internal:12345/other",
            "http://host.docker.internal:12345/v1?token=secret",
            "http://host.docker.internal:12345/v1#fragment",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe_origin(value)
