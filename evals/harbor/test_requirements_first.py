import json
import tempfile
import unittest
from pathlib import Path

from requirements_first import (
    RequirementsFirstReviewer,
    expectation_instruction,
    validate_expectations,
)


class RequirementsFirstTests(unittest.TestCase):
    def record(self):
        return {
            "expectations": [{"requirement": "Return a count", "example": "Two items",
                              "expected": "2", "basis": "explicit"}],
            "ambiguities": [], "limitations": [],
        }

    def test_stage_one_preserves_requests_without_task_specific_hint(self):
        original = "Serve the product.\nLater amendment: preserve ordering.\n"
        prompt = expectation_instruction(original)
        self.assertTrue(prompt.endswith(original))
        self.assertIn("no product implementation, design or tests", prompt)
        self.assertNotIn("rowid", prompt)
        self.assertNotIn("header", prompt)

    def test_structure_does_not_score_or_select_model_expectations(self):
        record = self.record()
        self.assertEqual(validate_expectations(record), record)
        record["expectations"][0]["expected"] = "Any wrong but structurally valid answer"
        self.assertEqual(validate_expectations(record), record)
        record["expectations"][0]["basis"] = "guaranteed"
        with self.assertRaisesRegex(ValueError, "basis"):
            validate_expectations(record)
        with self.assertRaises(ValueError):
            validate_expectations({"expectations": []})

    def test_handoff_drift_rejected_before_native_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "expectations.json"
            path.write_text(json.dumps(self.record()))
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                RequirementsFirstReviewer(
                    expectations_path=path, expectations_sha256="0" * 64
                )


class RequirementsStageIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_nonempty_repository_rejected_before_inference(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from ficus_agent import FicusSquad
        from requirements_first import RequirementsDrafter

        class Fixture(RequirementsDrafter):
            def __init__(self):
                self.base_commit = "a" * 40
                self.workspace = "/app"

            async def repository_state(self, environment):
                return self.base_commit + "\n"

            async def checked(self, environment, command, **kwargs):
                return "100644 blob hash\timplementation.py\n"

        with patch.object(FicusSquad, "run", new_callable=AsyncMock) as native:
            with self.assertRaisesRegex(ValueError, "empty base"):
                await Fixture().run("Original", None, SimpleNamespace(metadata={}))
            native.assert_not_awaited()

    async def test_empty_stage_checks_history_and_records_exact_output(self):
        import hashlib
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from ficus_agent import FicusSquad
        from requirements_first import RequirementsDrafter

        record = json.dumps(RequirementsFirstTests().record()).encode()
        with tempfile.TemporaryDirectory() as directory:
            class Fixture(RequirementsDrafter):
                def __init__(self):
                    self.base_commit = "a" * 40
                    self.workspace = "/app"
                    self.logs_dir = Path(directory)
                    self.extra_history = False

                async def repository_state(self, environment):
                    return self.base_commit + "\n"

                async def checked(self, environment, command, **kwargs):
                    if command == "git ls-tree -r HEAD":
                        return ""
                    return self.base_commit + ("\n" + "b" * 40 if self.extra_history else "")

            async def download(source, destination):
                destination.write_bytes(record)

            context = SimpleNamespace(metadata={"attempted_roles": ["reviewer"],
                "executed_roles": ["reviewer"], "outcome": "delivered"})
            environment = SimpleNamespace(download_file=AsyncMock(side_effect=download))
            fixture = Fixture()
            with patch.object(FicusSquad, "run", new_callable=AsyncMock) as native:
                await fixture.run("Original", environment, context)
                native.assert_awaited_once()
                self.assertEqual(context.metadata["requirements_stage"]["expectations_sha256"],
                                 hashlib.sha256(record).hexdigest())
                fixture.extra_history = True
                native.reset_mock()
                with self.assertRaisesRegex(ValueError, "empty base"):
                    await fixture.run("Original", environment, context)
                native.assert_not_awaited()

    async def test_handoff_preserves_bytes_and_rejects_mutation(self):
        import hashlib
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from artifact_reviewer import FicusArtifactReviewer

        record = json.dumps(RequirementsFirstTests().record()).encode()
        for mutate in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                class Fixture(RequirementsFirstReviewer):
                    def __init__(self):
                        self.logs_dir = Path(directory)
                        self.expectations_bytes = record
                        self.expectations_sha = hashlib.sha256(record).hexdigest()

                async def download(source, destination):
                    destination.write_bytes(record + (b" " if mutate else b""))

                environment = SimpleNamespace(upload_file=AsyncMock(),
                    download_file=AsyncMock(side_effect=download))
                with patch.object(FicusArtifactReviewer, "run", new_callable=AsyncMock) as native:
                    fixture = Fixture()
                    if mutate:
                        with self.assertRaisesRegex(ValueError, "changed"):
                            await fixture.run("Original", environment, SimpleNamespace(metadata={}))
                    else:
                        await fixture.run("Original", environment, SimpleNamespace(metadata={}))
                    audit = json.loads((Path(directory) / "requirements-handoff.json").read_text())
                    self.assertEqual(audit["valid"], not mutate)
                    self.assertEqual((Path(directory) / "requirements-expectations-input.json").read_bytes(), record)
                    self.assertTrue(native.call_args.args[0].startswith("Original"))
