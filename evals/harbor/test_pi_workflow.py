import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pi_workflow import PiWorkflow, PiWorkflowOptions, planned_handoff


class PiWorkflowTests(unittest.TestCase):
    def test_baseline_sol_limits_match_native_ficus(self):
        agent = object.__new__(PiWorkflow)
        agent.options = PiWorkflowOptions(
            model_api="openai-responses", thinking="medium"
        )
        access = SimpleNamespace(
            api_key="scoped",
            env={"OPENAI_API_KEY": "scoped"},
            configured_base_url="http://host.docker.internal:1/v1",
        )
        config = agent._build_custom_models_json(access, "gpt-6.1-sol")
        provider = config["providers"]["harbor-endpoint"]
        self.assertEqual(provider["api"], "openai-responses")
        self.assertEqual(provider["apiKey"], "$OPENAI_API_KEY")
        self.assertEqual(provider["models"][0]["maxTokens"], 8192)
        self.assertTrue(provider["models"][0]["reasoning"])

    def test_parent_usage_is_never_reported_as_whole_squad_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = object.__new__(PiWorkflow)
            agent.workflow = "planned"
            agent.logs_dir = Path(directory)
            context = SimpleNamespace(
                metadata={},
                n_input_tokens=100,
                n_output_tokens=20,
                n_cache_tokens=0,
                cost_usd=0,
            )
            with patch("pi_workflow.Pi.populate_context_post_run"):
                agent.populate_context_post_run(context)
            self.assertIsNone(context.n_input_tokens)
            self.assertIsNone(context.cost_usd)
            self.assertFalse(context.metadata["required_roles_executed"])

    def test_post_run_audits_child_roles_and_keeps_raw_session(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = object.__new__(PiWorkflow)
            agent.workflow = "planned"
            agent.logs_dir = Path(directory)
            sessions = agent.logs_dir / agent._SESSIONS_DIRECTORY
            sessions.mkdir(parents=True)
            session = sessions / "parent.jsonl"
            session.write_text(
                json.dumps(
                    {
                        "message": {
                            "role": "toolResult",
                            "toolName": "subagent",
                            "details": {
                                "results": [
                                    {
                                        "agent": role,
                                        "exitCode": 0,
                                        "usage": {"turns": 2},
                                    }
                                    for role in ("architect", "engineer", "reviewer")
                                ]
                            },
                        }
                    }
                )
                + "\n"
            )
            trajectory = agent.logs_dir / agent._TRAJECTORY_FILENAME
            trajectory.write_text("{}")
            context = SimpleNamespace(
                metadata=None,
                cost_usd=1,
                n_input_tokens=10,
                n_output_tokens=2,
                n_cache_tokens=0,
            )
            with patch("pi_workflow.Pi.populate_context_post_run"):
                agent.populate_context_post_run(context)
            self.assertEqual(
                context.metadata["executed_roles"],
                ["architect", "engineer", "reviewer"],
            )
            self.assertTrue(context.metadata["required_roles_executed"])
            self.assertTrue(session.exists())
            self.assertFalse(trajectory.exists())
            self.assertIsNone(context.n_input_tokens)

    def test_task_preserved_with_explicit_review_and_rework(self):
        task = "A task\n  "
        handoff = planned_handoff(task)
        self.assertIn("BEGIN TASK\n" + task + "\nEND TASK", handoff)
        self.assertIn("reviewer approval", handoff)
        self.assertIn("requested revisions", handoff)
