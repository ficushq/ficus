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

    def test_recovery_results_ignore_original_attempts_and_are_not_four_arm_comparison(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            ledger = root / "ledger.sqlite"
            Budget(ledger)
            manifest = {
                "experiment": "concurrent-feature-v1-recovery-1",
                "job_prefix": "cv1r1",
                "tasks": [{"short": "a", "task": "a"}, {"short": "b", "task": "b"}],
                "arms": ["ficus-planned"],
            }
            frozen = root / "manifest.json"
            frozen.write_text(json.dumps(manifest))
            exits = {}
            for short in ("a", "b"):
                for prefix in ("cv1", "cv1r1"):
                    client = f"{prefix}-{short}-ficus-planned"
                    trial = root / client / "trial"
                    trial.mkdir(parents=True)
                    (trial / "result.json").write_text(
                        json.dumps(
                            {
                                "started_at": "2026-10-20T00:00:00",
                                "finished_at": "2026-10-20T00:01:00",
                                "verifier_result": {
                                    "rewards": {"reward": int(prefix == "cv1r1")}
                                },
                            }
                        )
                    )
                    with sqlite3.connect(ledger) as db:
                        db.execute(
                            "INSERT INTO calls(client,charge,usage) VALUES(?,?,?)",
                            (
                                client,
                                100_000 if prefix == "cv1r1" else 5_500_000,
                                "{}" if prefix == "cv1r1" else None,
                            ),
                        )
                    if prefix == "cv1r1":
                        exits[client] = 0
            (root / "ficus-planned-batch.json").write_text(
                json.dumps({"elapsed_seconds": 120, "exit_codes": exits})
            )
            report = summarize_batches(root, ledger, frozen, manifest)
            self.assertTrue(report["complete_requested_batches"])
            self.assertFalse(report["complete_matched_comparison"])
            self.assertEqual(report["experiment"], manifest["experiment"])
            self.assertEqual(report["new_confirmed_usd"], 0.2)
            self.assertEqual(report["cumulative_exposure_usd"], 11.2)
            self.assertEqual(report["batches"][0]["accepted_tasks"], 2)
            self.assertEqual(report["batches"][0]["accepted_tasks_per_hour"], 60)
            for task in report["tasks"]:
                self.assertEqual(len(task["results"]), 1)
                self.assertTrue(task["results"][0]["job_name"].startswith("cv1r1-"))

    def test_used_client_is_rejected_even_with_empty_jobs_directory(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from run_concurrent_feature import run

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            ledger = root / "ledger.sqlite"
            budget = Budget(ledger)
            budget.reserve("cv1r1-a-ficus-planned")
            manifest = {
                "job_prefix": "cv1r1",
                "tasks": [{"short": "a", "task": "a"}, {"short": "b", "task": "b"}],
                "arms": ["ficus-planned"],
                "concurrency": 2,
                "prior_last_call_id": 1,
                "cumulative_cap_usd": 50,
            }
            frozen = root / "manifest.json"
            frozen.write_text(json.dumps(manifest))
            args = SimpleNamespace(
                frozen=frozen,
                frozen_sha256=sha(frozen),
                jobs=root / "new-jobs",
                ledger=ledger,
                tasks=root,
                runtime=root / "runtime",
                access=root / "access",
            )
            with (
                patch("run_concurrent_feature.validate_inputs"),
                patch("run_concurrent_feature.subprocess.Popen") as launch,
            ):
                with self.assertRaisesRegex(
                    ValueError, "reuse an existing inference client"
                ):
                    run(args)
                launch.assert_not_called()

    def test_invalid_namespace_is_rejected(self):
        from run_concurrent_feature import job_prefix

        for value in ("../old", "", "a/b", "A", None):
            with self.assertRaisesRegex(ValueError, "Invalid job namespace"):
                job_prefix({"job_prefix": value}, {"short": "a"})
        self.assertEqual(job_prefix({}, {"short": "a"}), "cv1-a")
