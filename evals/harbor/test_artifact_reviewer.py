import tempfile
import unittest
from pathlib import Path

from artifact_reviewer import (
    FicusArtifactReviewer,
    review_instruction,
    validate_provenance,
    validate_report,
)
from ficus_agent import squad_handoff


class ArtifactReviewTests(unittest.TestCase):
    def test_patch_drift_rejected_before_runtime_or_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.patch"
            path.write_text("changed")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                FicusArtifactReviewer(
                    artifact_patch=path, artifact_sha256="0" * 64, base_commit="a" * 40
                )

    def test_mutation_and_extra_agent_invalidate_review(self):
        metadata = {
            "attempted_roles": ["reviewer"],
            "executed_roles": ["reviewer"],
            "outcome": "delivered",
        }
        validate_provenance(metadata, "same", "same")
        with self.assertRaisesRegex(ValueError, "modified"):
            validate_provenance(metadata, "same", "different")
        with self.assertRaisesRegex(ValueError, "only native"):
            validate_provenance(
                {**metadata, "attempted_roles": ["engineer", "reviewer"]},
                "same",
                "same",
            )
        with self.assertRaisesRegex(ValueError, "finish"):
            validate_provenance(
                {**metadata, "outcome": "waiting-for-human"}, "same", "same"
            )

    def test_report_requires_supported_explicit_findings(self):
        report = {
            "verdict": "approve",
            "findings": [],
            "observations": [],
            "limitations": [],
        }
        self.assertEqual(validate_report(report), report)
        with self.assertRaises(ValueError):
            validate_report({**report, "verdict": "changes-requested"})
        with self.assertRaises(ValueError):
            validate_report({**report, "findings": [{"title": "bug"}]})
        finding = dict.fromkeys(
            ("title", "requirement", "location", "evidence", "severity"),
            "specific evidence",
        )
        self.assertEqual(
            validate_report(
                {**report, "verdict": "changes-requested", "findings": [finding]}
            )["findings"],
            [finding],
        )

    def test_original_task_preserved_and_no_manager_handoff(self):
        original = "Implement the requested API.\nKeep compatibility.\n"
        message = review_instruction(original, "a" * 40, "b" * 40)
        self.assertTrue(message.endswith(original))
        self.assertEqual(squad_handoff(message, "reviewer"), message)
