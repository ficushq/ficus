import concurrent.futures
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from budget_proxy import FULL_MODEL, MODEL, RESERVATION, Budget, handler, validate
from ficus_agent import FicusSquad, disposition


class CompletionTests(unittest.TestCase):
    def state(self):
        return {
            "agents": [{"status": "idle"}],
            "executions": [{"status": "completed"}],
            "streams": [{"status": "done"}],
        }

    def test_workers_must_finish_even_when_manager_is_idle(self):
        state = self.state()
        state["executions"].append({"status": "running"})
        self.assertIsNone(disposition(state))

    def test_unconsumed_completion_message_prevents_early_stop(self):
        state = self.state()
        state["pendingMessages"] = [{"id": "queued-manager-notification"}]
        self.assertIsNone(disposition(state))

    def test_human_question_is_not_success(self):
        state = self.state()
        state["agents"][0]["status"] = "waiting-input"
        self.assertEqual(disposition(state), "waiting-for-human")

    def test_open_stream_prevents_completion(self):
        state = self.state()
        state["streams"][0]["status"] = "active"
        self.assertIsNone(disposition(state))

    def test_finished_squad_is_delivered(self):
        self.assertEqual(disposition(self.state()), "delivered")


class BudgetTests(unittest.TestCase):
    def test_concurrent_agents_share_cap_and_unknown_usage_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spend.sqlite"
            budget = Budget(path, 1)

            def reserve(_):
                try:
                    return budget.reserve("squad")
                except ValueError:
                    return None

            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                results = list(pool.map(reserve, range(10)))
            self.assertEqual(len([r for r in results if r]), 2)
            restarted = Budget(path, 1)
            with self.assertRaises(ValueError):
                restarted.reserve("baseline")
            self.assertEqual(restarted.summary()["squad"]["usd_upper_bound"], 1)

    def test_usage_settlement_includes_cached_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(Path(directory) / "spend.sqlite")
            identifier = budget.reserve("squad")
            budget.settle(
                identifier,
                {
                    "prompt_tokens": 1000000,
                    "completion_tokens": 1000,
                    "prompt_tokens_details": {"cached_tokens": 500000},
                },
            )
            self.assertAlmostEqual(budget.summary()["squad"]["usd_upper_bound"], 0.2516)
            self.assertEqual(budget.summary()["squad"]["unknown_usage"], 0)

    def test_bad_usage_keeps_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(Path(directory) / "spend.sqlite")
            identifier = budget.reserve("squad")
            with self.assertRaises(ValueError):
                budget.settle(identifier, {"prompt_tokens": -1, "completion_tokens": 0})
            self.assertEqual(
                budget.summary()["squad"]["usd_upper_bound"], RESERVATION / 1e6
            )

    def test_disallow_other_models_and_multimodal_costs(self):
        for payload in (
            {"model": "other"},
            {"model": MODEL, "n": 2},
            {"model": MODEL, "messages": [{"content": [{"type": "image_url"}]}]},
            {"model": MODEL, "tools": [{"type": "web_search"}]},
        ):
            with self.assertRaises(ValueError):
                validate(payload)

    def test_full_model_keeps_previous_model_spend_in_same_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spend.sqlite"
            mini = Budget(path, 3)
            mini.reserve("previous-unknown-usage")
            full = Budget(path, 3, FULL_MODEL)
            identifier = full.reserve("full-squad")
            with self.assertRaises(ValueError):
                full.reserve("another-agent")
            full.settle(
                identifier,
                {
                    "prompt_tokens": 1000000,
                    "completion_tokens": 1000,
                    "prompt_tokens_details": {"cached_tokens": 500000},
                },
            )
            self.assertAlmostEqual(
                full.summary()["full-squad"]["usd_upper_bound"], 1.258
            )
            self.assertEqual(
                full.summary()["previous-unknown-usage"]["usd_upper_bound"], 0.5
            )

    def test_stream_usage_and_output_ceiling(self):
        request = validate(
            {"model": MODEL, "stream": True, "max_completion_tokens": 50000}
        )
        self.assertEqual(request["max_completion_tokens"], 8192)
        self.assertTrue(request["stream_options"]["include_usage"])


class AccountingTests(unittest.TestCase):
    def test_all_roles_including_failed_attempts_are_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            snapshot = {
                "agents": [
                    {"id": "m", "agentTypeId": "manager"},
                    {"id": "e", "agentTypeId": "engineer"},
                    {"id": "r", "agentTypeId": "reviewer"},
                ],
                "executions": [
                    {"agentId": "m", "status": "completed"},
                    {"agentId": "e", "status": "completed"},
                    {"agentId": "r", "status": "completed"},
                ],
                "usage": [
                    {
                        "inputTokens": 10,
                        "cacheReadTokens": 2,
                        "cacheWriteTokens": 0,
                        "outputTokens": 5,
                    }
                    for _ in range(4)
                ],
            }
            (path / "snapshot.json").write_text(json.dumps(snapshot))
            context = SimpleNamespace(metadata={"outcome": "delivered"})
            FicusSquad.populate_context_post_run(
                SimpleNamespace(logs_dir=path), context
            )
            self.assertEqual(context.n_input_tokens, 48)
            self.assertEqual(context.n_output_tokens, 20)
            self.assertEqual(context.n_cache_tokens, 8)
            self.assertEqual(
                context.metadata["executed_roles"], ["engineer", "manager", "reviewer"]
            )
            self.assertIsNone(context.cost_usd)


class ProxyTests(unittest.TestCase):
    def test_client_disconnect_still_collects_upstream_usage(self):
        class Response:
            status_code = 200

            def __init__(self):
                self.headers = {"Content-Type": "text/event-stream"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def iter_lines(self):
                yield b'data: {"choices": []}'
                yield b""
                yield b'data: {"usage": {"prompt_tokens": 100, "completion_tokens": 10}}'
                yield b""
                yield b"data: [DONE]"

        class Disconnected:
            def write(self, value):
                raise BrokenPipeError()

        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(Path(directory) / "spend.sqlite")
            cls = handler(budget, {"test-token": "trial"}, "dummy-test-key")
            request = object.__new__(cls)
            body = json.dumps({"model": MODEL, "stream": True, "messages": []}).encode()
            request.headers = {
                "Authorization": "Bearer test-token",
                "Content-Length": str(len(body)),
            }
            request.path = "/v1/chat/completions"
            request.rfile = io.BytesIO(body)
            request.wfile = Disconnected()
            request.send_response = lambda *_: None
            request.send_header = lambda *_: None
            request.end_headers = lambda: None
            with patch("budget_proxy.requests.post", return_value=Response()):
                request.do_POST()
            summary = budget.summary()["trial"]
            self.assertEqual(summary["unknown_usage"], 0)
            self.assertAlmostEqual(summary["usd_upper_bound"], 0.000056)


if __name__ == "__main__":
    unittest.main()
