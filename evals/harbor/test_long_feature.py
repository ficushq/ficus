import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from budget_proxy import Budget
from summarize_long_feature import ARMS, summarize


class LongFeatureSummaryTests(unittest.TestCase):
    def test_complete_requires_all_finished_receipts_and_keeps_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frozen = root / "frozen.json"
            frozen.write_text("{}")
            ledger = root / "spend.sqlite"
            Budget(ledger)
            for index, arm in enumerate(ARMS):
                trial = root / f"run-{arm}" / "trial"
                trial.mkdir(parents=True)
                (trial / "result.json").write_text(
                    json.dumps(
                        {
                            "started_at": "2026-10-20T00:00:00",
                            "finished_at": "2026-10-20T00:01:30",
                            "verifier_result": {"rewards": {"reward": int(index == 0)}},
                        }
                    )
                )
                with sqlite3.connect(ledger) as db:
                    db.execute(
                        "INSERT INTO calls(client,charge,usage) VALUES(?,?,?)",
                        (f"run-{arm}", 100_000, "{}"),
                    )
            report = summarize(root, ledger, frozen, "run")
            self.assertTrue(report["complete_matched_comparison"])
            self.assertEqual(report["new_confirmed_usd"], 0.4)
            self.assertEqual(report["cumulative_exposure_usd"], 0.4)
            self.assertEqual(report["results"][1]["reward"]["reward"], 0)
            self.assertEqual(report["results"][0]["total_seconds"], 90)
            self.assertIsNone(report["results"][0]["human_attention_minutes"])
            with sqlite3.connect(ledger) as db:
                db.execute(
                    "INSERT INTO calls(client,charge) VALUES(?,?)",
                    ("run-pi-engineer", 5_500_000),
                )
            report = summarize(root, ledger, frozen, "run")
            self.assertFalse(report["complete_matched_comparison"])
            self.assertEqual(report["new_confirmed_usd"], 0.4)
            self.assertEqual(report["cumulative_exposure_usd"], 5.9)
            self.assertEqual(report["results"][-1]["unknown_usage_requests"], 1)

    def test_no_result_is_incomplete_and_multiple_attempts_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frozen = root / "frozen.json"
            frozen.write_text("{}")
            ledger = root / "spend.sqlite"
            Budget(ledger)
            self.assertFalse(
                summarize(root, ledger, frozen, "run")["complete_matched_comparison"]
            )
            for name in ("a", "b"):
                p = root / "run-ficus-planned" / name
                p.mkdir(parents=True)
                (p / "result.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "multiple attempts"):
                summarize(root, ledger, frozen, "run")


if __name__ == "__main__":
    unittest.main()
