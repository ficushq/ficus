import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from longitudinal import (
    FicusLongitudinal,
    capture_stage,
    handoff,
    load_requests,
    validate_pi_increment,
)
from longitudinal_bootstrap import render
from longitudinal_verify import counts
from coordination import BOOTSTRAP
from prepare_longitudinal import drain_fixture


class SequentialTests(unittest.TestCase):
    def test_manifest_is_frozen_and_first_prompt_has_no_later_request(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "requests.json"
            p.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "requests": [
                            "first-sentinel",
                            "second-private-sentinel",
                            "third-private-sentinel",
                        ],
                    }
                )
            )
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            requests = load_requests(p, digest)
            self.assertNotIn(requests[1], handoff(requests[0], "ficus", 1))
            self.assertNotIn(requests[2], handoff(requests[0], "pi", 1))
            p.write_text(p.read_text() + " ")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                load_requests(p, digest)

    def test_bootstrap_fails_closed_and_retains_original_guards(self):
        source = BOOTSTRAP.read_text()
        overlay = render(source)
        self.assertIn("memory: { enabled: true }", overlay)
        self.assertIn("Refusing a non-Harbor database", overlay)
        self.assertIn("Squad.mustFind(identity.squadId)", overlay)
        self.assertIn("manager.sendMessage(request.instruction", overlay)
        self.assertIn("squad.managerAgentId !== identity.managerId", overlay)
        with self.assertRaises(ValueError):
            render(overlay)

    def test_pi_requires_successful_native_roles_and_preserved_history(self):
        def line(message):
            return (json.dumps({"type": "message", "message": message}) + "\n").encode()

        roles = line(
            {
                "role": "toolResult",
                "toolName": "subagent",
                "details": {
                    "results": [
                        {"agent": r, "exitCode": 0, "usage": {"turns": 1}}
                        for r in ["architect", "engineer", "reviewer"]
                    ]
                },
            }
        )
        final = line({"role": "assistant", "stopReason": "stop"})
        previous = b'{"type":"session","id":"same"}\n'
        self.assertEqual(
            validate_pi_increment(previous + roles + final, previous),
            ["architect", "engineer", "reviewer"],
        )
        for current in [
            roles + final,
            previous + final,
            previous + roles + line({"role": "assistant", "stopReason": "error"}),
        ]:
            with self.assertRaises(RuntimeError):
                validate_pi_increment(current, previous)

    def test_dirty_artifact_refused_without_creating_delivery(self):
        with tempfile.TemporaryDirectory() as d:
            env = SimpleNamespace(
                exec=AsyncMock(return_value=SimpleNamespace(return_code=1)),
                download_file=AsyncMock(),
            )
            with self.assertRaisesRegex(RuntimeError, "clean committed"):
                asyncio.run(capture_stage(env, d, 1))
            env.download_file.assert_not_called()
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_ficus_wait_does_not_release_request(self):
        agent = object.__new__(FicusLongitudinal)
        agent.upload_json = AsyncMock()
        self.assertFalse(asyncio.run(agent.on_settled("waiting", None, None)))
        agent.upload_json.assert_not_called()

    def test_snapshot_precedes_ficus_followup(self):
        with tempfile.TemporaryDirectory() as d:
            agent = object.__new__(FicusLongitudinal)
            agent.logs_dir = Path(d)
            agent.increment = 1
            agent.deliveries = []
            agent.requests = ["first", "second-private", "third-private"]
            events = []

            async def capture(*args):
                events.append("capture")
                return {"increment": 1, "clean": True}

            async def bootstrap(*args):
                events.append(args[1])

            async def upload(environment, destination, payload):
                events.append("release")
                self.assertIn("second-private", payload["instruction"])
                self.assertNotIn("third-private", payload["instruction"])

            agent.bootstrap_command = bootstrap
            agent.upload_json = upload
            agent.checked = AsyncMock()
            env = SimpleNamespace(download_file=AsyncMock())
            with patch("longitudinal.capture_stage", capture):
                self.assertTrue(asyncio.run(agent.on_settled("delivered", env, None)))
            self.assertLess(events.index("capture"), events.index("release"))
            self.assertLess(events.index("memory-export"), events.index("release"))
            self.assertEqual(agent.increment, 2)

    def test_score_does_not_count_skips_or_errors_as_passes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "result.xml"
            p.write_text(
                "<testsuites><testsuite><testcase/><testcase><failure/></testcase><testcase><error/></testcase><testcase><skipped/></testcase></testsuite></testsuites>"
            )
            self.assertEqual(
                counts(p),
                {"tests": 4, "passed": 1, "failed": 1, "errors": 1, "skipped": 1},
            )

    def test_log_only_overlay_rejects_unexpected_fixture(self):
        with self.assertRaises((ValueError, AssertionError)):
            drain_fixture("def _run_service():\n    pass\n")


if __name__ == "__main__":
    unittest.main()
