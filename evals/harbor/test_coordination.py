import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from coordination import FicusCoordination, PiCoordination, handoff, ROOT


class CoordinationTests(unittest.IsolatedAsyncioTestCase):
    def test_same_task_and_contract_for_both_harnesses(self):
        task = "original requirements\n  "
        for harness in ("ficus", "pi"):
            text = handoff(task, harness)
            self.assertIn("BEGIN REQUESTS\n" + task + "\nEND REQUESTS", text)
            self.assertIn("at least three distinct implementation", text)
            self.assertIn("final integration/review", text)
            self.assertIn("at most two workers", text)
            self.assertIn("not the implementer", text)
        self.assertIn("native Ficus work streams", handoff(task, "ficus"))
        self.assertIn("packaged subagent tool", handoff(task, "pi"))

    async def test_only_coordination_trial_replaces_single_task_seed(self):
        agent = object.__new__(FicusCoordination)
        agent.coordination_instruction = "shared repository"
        with patch(
            "coordination.FicusSquad.upload_json", new_callable=AsyncMock
        ) as upload:
            await agent.upload_json(
                None,
                ROOT + "/trial.json",
                {"instruction": "single task", "key": "scoped"},
            )
            payload = upload.call_args.args[2]
            self.assertEqual(payload["instruction"], "shared repository")
            self.assertEqual(payload["key"], "scoped")
            self.assertTrue(payload["coordination"])
            await agent.upload_json(None, ROOT + "/other.json", {"keep": True})
            self.assertEqual(upload.call_args.args[2], {"keep": True})

    async def test_pi_uses_coordination_contract_without_single_task_wrapper(self):
        agent = object.__new__(PiCoordination)
        context = SimpleNamespace(metadata={})
        with patch("coordination.Pi.run", new_callable=AsyncMock) as run:
            await agent.run("task", None, context)
            self.assertEqual(run.call_args.args[1], handoff("task", "pi"))
            self.assertEqual(context.metadata["study"], "coordination-v1")

    async def test_pi_fails_closed_if_packaged_extension_changes(self):
        agent = object.__new__(PiCoordination)
        with tempfile.TemporaryDirectory() as d:
            agent.logs_dir = Path(d)
            agent.exec_as_agent = AsyncMock(
                return_value=SimpleNamespace(return_code=1, stdout="")
            )
            with patch("coordination.PiWorkflow.install", new_callable=AsyncMock):
                with self.assertRaises(RuntimeError):
                    await agent.install(None)
