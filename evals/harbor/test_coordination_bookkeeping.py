import unittest
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

from coordination import handoff as original_handoff
from coordination_bookkeeping import (
    BOOKKEEPING,
    FicusBookkeepingCoordination,
    PiBookkeepingCoordination,
    handoff,
)


class BookkeepingTests(unittest.IsolatedAsyncioTestCase):
    def test_same_permission_and_limits_without_changing_original_requests(self):
        request = "Original request with spacing  and\nline breaks."
        for harness in ("ficus", "pi"):
            result = handoff(request, harness)
            self.assertEqual(result.count(BOOKKEEPING), 1)
            self.assertEqual(
                result.split("\nBEGIN REQUESTS\n", 1)[1], request + "\nEND REQUESTS"
            )
            self.assertEqual(
                result.replace("\n" + BOOKKEEPING, ""),
                original_handoff(request, harness),
            )
        self.assertIn("permission excludes product code, tests,", BOOKKEEPING)
        self.assertIn("preserve every\ndeclared review gate", BOOKKEEPING)

    def test_runner_rejects_missing_or_changed_audit_before_reading_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "audit.json"
            report.write_text("{}")
            command = [
                sys.executable,
                str(Path(__file__).with_name("run-pilot.py")),
                "pi",
                str(root),
                "--workflow",
                "planned",
                "--coordination",
                "--coordination-bookkeeping",
                "--access",
                str(root / "missing-access.json"),
                "--jobs-dir",
                str(root / "jobs"),
                "--job-name",
                "blocked",
            ]
            missing = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn(
                "requires coordination and a pinned contract audit", missing.stderr
            )
            changed = subprocess.run(
                command
                + [
                    "--contract-audit",
                    str(report),
                    "--contract-audit-sha256",
                    "0" * 64,
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(changed.returncode, 0)
            self.assertIn("Audit report hash mismatch", changed.stderr)
            self.assertNotIn("FileNotFoundError", changed.stderr)
            self.assertFalse((root / "jobs").exists())

    async def test_ficus_delivers_the_versioned_instruction_to_existing_bootstrap(self):
        agent = object.__new__(FicusBookkeepingCoordination)
        context = SimpleNamespace(metadata={})
        with patch(
            "coordination_bookkeeping.FicusSquad.run", new_callable=AsyncMock
        ) as run:
            await agent.run("Build this", object(), context)
        self.assertEqual(agent.coordination_instruction, handoff("Build this", "ficus"))
        run.assert_awaited_once()
        self.assertEqual(context.metadata["study"], "coordination-bookkeeping-v1")

    async def test_pi_receives_the_same_versioned_policy(self):
        agent = object.__new__(PiBookkeepingCoordination)
        environment = object()
        context = SimpleNamespace(metadata={})
        with patch("coordination_bookkeeping.Pi.run", new_callable=AsyncMock) as run:
            await agent.run("Build this", environment, context)
        self.assertEqual(run.await_args.args[1], handoff("Build this", "pi"))
        self.assertEqual(context.metadata["study"], "coordination-bookkeeping-v1")


if __name__ == "__main__":
    unittest.main()
