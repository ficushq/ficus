import hashlib
import tempfile
import unittest
from pathlib import Path

from reviewer_contract import frozen_prompt


class PromptOverlayTests(unittest.TestCase):
    def test_drift_and_wrong_role_rejected_before_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reviewer.yaml"
            data = b'id: reviewer\nsystemPrompt: "Check the original request."\n'
            path.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            self.assertEqual(
                frozen_prompt(path, digest), (data, "Check the original request.")
            )
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                frozen_prompt(path, "0" * 64)
            other = data.replace(b'reviewer', b'engineer')
            path.write_bytes(other)
            with self.assertRaisesRegex(ValueError, "reviewer agent type"):
                frozen_prompt(path, hashlib.sha256(other).hexdigest())
