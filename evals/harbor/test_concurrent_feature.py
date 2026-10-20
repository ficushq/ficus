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

    def test_inflight_is_allowed_but_stream_failure_stops_only_its_batch(self):
        from run_concurrent_feature import check_provider_failures

        with tempfile.TemporaryDirectory() as folder:
            ledger = Path(folder) / "ledger.sqlite"
            budget = Budget(ledger)
            call = budget.reserve("current")
            budget.note(call, status=200)
            check_provider_failures(ledger, ["current"])
            budget.note(
                call,
                failure="upstream_stream_error",
                provider_code="insufficient_quota",
            )
            check_provider_failures(ledger, ["different-batch"])
            with self.assertRaisesRegex(ValueError, "Provider failure for current"):
                check_provider_failures(ledger, ["current"])
            self.assertEqual(budget.summary()["current"]["unknown_usage"], 1)

    def test_provider_failure_terminates_both_owned_processes_and_records_stop(self):
        import subprocess
        import sys
        from types import SimpleNamespace
        from unittest.mock import patch
        from run_concurrent_feature import run

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            jobs = root / "jobs"
            ledger = root / "ledger.sqlite"
            budget = Budget(ledger, 50)
            manifest = {
                "tasks": [{"task": "a", "short": "a"}, {"task": "b", "short": "b"}],
                "arms": ["pi-planned"],
                "concurrency": 2,
                "prior_last_call_id": 0,
                "cumulative_cap_usd": 50,
            }
            frozen = root / "frozen.json"
            frozen.write_text(json.dumps(manifest))
            args = SimpleNamespace(
                frozen=frozen,
                frozen_sha256=sha(frozen),
                jobs=jobs,
                ledger=ledger,
                tasks=root,
                runtime=root / "runtime",
                access=root / "access",
            )
            real_popen = subprocess.Popen
            children = []

            def start_fixture(command, **kwargs):
                child = real_popen(
                    [sys.executable, "-c", "import time; time.sleep(30)"], **kwargs
                )
                children.append(child)
                if len(children) == 2:
                    call = budget.reserve("cv1-a-pi-planned")
                    budget.note(call, status=200, failure="upstream_stream_error")
                return child

            try:
                with (
                    patch("run_concurrent_feature.validate_inputs"),
                    patch(
                        "run_concurrent_feature.subprocess.Popen",
                        side_effect=start_fixture,
                    ),
                ):
                    with self.assertRaisesRegex(ValueError, "Provider failure"):
                        run(args)
                self.assertEqual(len(children), 2)
                self.assertTrue(all(child.poll() is not None for child in children))
                batch = json.loads((jobs / "pi-planned-batch.json").read_text())
                self.assertIn("Provider failure", batch["stop_reason"])
                self.assertEqual(
                    set(batch["exit_codes"]), {"cv1-a-pi-planned", "cv1-b-pi-planned"}
                )
                self.assertEqual(
                    budget.summary()["cv1-a-pi-planned"]["unknown_usage"], 1
                )
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)
