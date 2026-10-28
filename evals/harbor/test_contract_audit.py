import copy
import json
from pathlib import Path
import tempfile
import unittest

from contract_audit import AuditRejected, digest, require_ready, validate


class ContractAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, text in {
            "request.md": "Return an integer count.",
            "test.py": "assert response['count'] == 1",
            "nodes.json": json.dumps(["test.py::test_count"]),
        }.items():
            (self.root / name).write_text(text)
        self.report = {
            "schema_version": 1,
            "stage": "pre-inference",
            "decision": "ready",
            "reviewer": "offline reviewer",
            "reviewed_at_utc": "2026-10-28T00:00:00Z",
            "files": {p.name: digest(p) for p in self.root.iterdir()},
            "inventory": {"file": "nodes.json"},
            "claims": [
                {
                    "test_ids": ["test.py::test_count"],
                    "status": "supported",
                    "rationale": "Expected integer count matches the stated output.",
                    "spec_evidence": [
                        {"file": "request.md", "quote": "Return an integer count."}
                    ],
                    "test_evidence": [
                        {"file": "test.py", "quote": "assert response['count'] == 1"}
                    ],
                }
            ],
            "unresolved_findings": [],
        }

    def test_ready_audit_with_pinned_evidence(self):
        p = self.root / "audit.json"
        p.write_text(json.dumps(self.report))
        require_ready(p, self.root, digest(p))

    def test_changed_inputs_and_report_cannot_reuse_approval(self):
        (self.root / "request.md").write_text("Return a string.")
        self.assertTrue(
            any("hash mismatch" in e for e in validate(self.report, self.root))
        )
        p = self.root / "audit.json"
        p.write_text(json.dumps(self.report))
        with self.assertRaisesRegex(AuditRejected, "report hash mismatch"):
            require_ready(p, self.root, "0" * 64)

    def test_ambiguity_and_unreviewed_coverage_fail_closed(self):
        r = copy.deepcopy(self.report)
        r["claims"][0]["status"] = "ambiguous"
        self.assertTrue(any("disagreement" in e for e in validate(r, self.root)))
        r["claims"] = []
        self.assertIn("Unaudited tests: 1", validate(r, self.root))
        r = copy.deepcopy(self.report)
        r["unresolved_findings"] = ["Whole-second format is not specified"]
        self.assertIn("Unresolved findings remain", validate(r, self.root))

    def test_retrospective_or_rejected_audit_never_authorizes_run(self):
        for key, value in [("stage", "post-inference"), ("decision", "rejected")]:
            r = copy.deepcopy(self.report)
            r[key] = value
            self.assertTrue(validate(r, self.root))

    def test_fake_evidence_and_unknown_cases_are_rejected(self):
        for mutation in [
            lambda r: r["claims"][0]["spec_evidence"][0].update(quote="invented"),
            lambda r: r["claims"][0].update(test_ids=["unknown"]),
            lambda r: r.update(files={}),
            lambda r: r["claims"][0].update(test_evidence=[]),
        ]:
            r = copy.deepcopy(self.report)
            mutation(r)
            self.assertTrue(validate(r, self.root))


if __name__ == "__main__":
    unittest.main()
