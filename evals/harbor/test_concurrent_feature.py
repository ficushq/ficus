import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from budget_proxy import Budget
from run_concurrent_feature import summarize_batches, validate_inputs
from summarize_long_feature import sha


class ConcurrentFeatureTests(unittest.TestCase):
    def test_partial_batch_does_not_claim_throughput_or_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            frozen = root / "manifest.json"
            manifest = {
                "tasks": [{"short": "a", "task": "a"}, {"short": "b", "task": "b"}],
                "arms": ["pi-planned"],
            }
            frozen.write_text(json.dumps(manifest))
            ledger = root / "ledger.sqlite"
            Budget(ledger)
            batch = {
                "elapsed_seconds": 120,
                "exit_codes": {"cv1-a-pi-planned": 0, "cv1-b-pi-planned": 0},
            }
            (root / "pi-planned-batch.json").write_text(json.dumps(batch))
            for name in ("a", "b"):
                trial = root / f"cv1-{name}-pi-planned" / "trial"
                trial.mkdir(parents=True)
                (trial / "result.json").write_text(
                    json.dumps(
                        {
                            "started_at": "2026-10-20T00:00:00",
                            "finished_at": "2026-10-20T00:01:00",
                            "verifier_result": {
                                "rewards": {"reward": int(name == "a")}
                            },
                        }
                    )
                )
                with sqlite3.connect(ledger) as db:
                    db.execute(
                        "INSERT INTO calls(client,charge,usage) VALUES(?,?,?)",
                        (f"cv1-{name}-pi-planned", 100_000, "{}"),
                    )
                report = summarize_batches(root, ledger, frozen, manifest)
                if name == "a":
                    self.assertIsNone(report["batches"][0]["accepted_tasks_per_hour"])
                    self.assertFalse(report["complete_matched_comparison"])
            self.assertEqual(report["batches"][0]["accepted_tasks_per_hour"], 30)
            self.assertEqual(report["batches"][0]["accepted_tasks"], 1)
            self.assertEqual(report["new_confirmed_usd"], 0.2)
            with sqlite3.connect(ledger) as db:
                db.execute(
                    "INSERT INTO calls(client,charge) VALUES(?,?)",
                    ("cv1-b-pi-planned", 5_500_000),
                )
            report = summarize_batches(root, ledger, frozen, manifest)
            self.assertIsNone(report["batches"][0]["accepted_tasks_per_hour"])

    def test_input_drift_refuses_launch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.py"
            source.write_text("source")
            task = root / "task"
            task.mkdir()
            prompt = task / "instruction.md"
            prompt.write_text("official")
            runtime = root / "runtime"
            runtime.write_bytes(b"runtime")
            manifest = {
                "source_files_sha256": {"source.py": sha(source)},
                "tasks": [
                    {
                        "task": "task",
                        "prepared_file_sha256": {"instruction.md": sha(prompt)},
                    }
                ],
                "runtime_archive_sha256": sha(runtime),
            }
            validate_inputs(root, root, manifest, runtime)
            prompt.write_text("changed")
            with self.assertRaisesRegex(ValueError, "Task drift"):
                validate_inputs(root, root, manifest, runtime)
