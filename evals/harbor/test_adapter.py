import concurrent.futures
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from budget_proxy import (
    FULL_MODEL,
    MODEL,
    RESERVATION,
    Budget,
    handler,
    retry_delay,
    validate,
)
from ficus_agent import FicusSquad, disposition, squad_handoff


class HandoffTests(unittest.TestCase):
    def test_original_task_is_verbatim_and_orchestration_is_explicit(self):
        task = "An arbitrary task.\nKeep its exact wording and whitespace.  "
        handoff = squad_handoff(task)
        self.assertIn("BEGIN TASK\n" + task + "\nEND TASK", handoff)
        self.assertIn("--workflow builder-reviewer", handoff)
        self.assertIn("Do not implement the task yourself", handoff)
        self.assertIn("independent reviewer", handoff)

    def test_engineer_gets_original_task_without_manager_instruction(self):
        task = "Implement a feature.  "
        self.assertEqual(squad_handoff(task, "engineer"), task)

    def test_planned_inherits_saved_flow_and_requires_architect(self):
        text = squad_handoff("A task", "planned")
        self.assertNotIn("--workflow builder-reviewer", text)
        self.assertIn("architect planning stage", text)


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

    def test_authorized_cap_increase_preserves_old_unknown_reservations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spend.sqlite"
            original = Budget(path, 10, FULL_MODEL)
            for _ in range(4):
                original.reserve("old-unknown")
            with self.assertRaises(ValueError):
                original.reserve("next-run")
            increased = Budget(path, 20, FULL_MODEL)
            for _ in range(5):
                increased.reserve("next-run")
            with self.assertRaises(ValueError):
                increased.reserve("over-cap")
            self.assertEqual(increased.summary()["old-unknown"]["unknown_usage"], 4)
            self.assertAlmostEqual(
                increased.summary()["old-unknown"]["usd_upper_bound"], 8.8
            )
            self.assertAlmostEqual(
                increased.summary()["next-run"]["usd_upper_bound"], 11
            )

    def test_reconciliation_preserves_calls_and_new_spend_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spend.sqlite"
            budget = Budget(path, 5, FULL_MODEL)
            budget.reserve("unknown")
            paid = budget.reserve("metered")
            budget.settle(paid, {"prompt_tokens": 100000, "completion_tokens": 0})
            budget.reconcile("0.21", "User verified provider total; rounded upward")
            self.assertAlmostEqual(budget.total(), 0.21)
            restarted = Budget(path, 5, FULL_MODEL)
            restarted.reserve("new-one")
            restarted.reserve("new-two")
            self.assertAlmostEqual(restarted.total(), 4.61)
            with self.assertRaises(ValueError):
                restarted.reserve("over-cap")
            with sqlite3.connect(path) as db:
                self.assertEqual(
                    db.execute("SELECT charge,usage FROM calls WHERE id=1").fetchone(),
                    (2200000, None),
                )
                self.assertEqual(
                    db.execute(
                        "SELECT through_call,upper_bound,confirmed,raw_exposure FROM reconciliations"
                    ).fetchone(),
                    (2, 210000, 200000, 2400000),
                )
            with self.assertRaises(ValueError):
                restarted.reconcile("0.1", "Below metered cost")
            with self.assertRaises(ValueError):
                restarted.reconcile("nan", "Invalid")
            with self.assertRaises(ValueError):
                restarted.reconcile("5", "")

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
    def request(self, cls):
        request = object.__new__(cls)
        body = json.dumps({"model": MODEL, "messages": []}).encode()
        request.headers = {
            "Authorization": "Bearer test-token",
            "Content-Length": str(len(body)),
        }
        request.path = "/v1/chat/completions"
        request.rfile = io.BytesIO(body)
        request.wfile = io.BytesIO()
        request.response_headers = {}
        request.send_response = lambda status: setattr(request, "status", status)
        request.send_header = lambda key, value: request.response_headers.update(
            {key: value}
        )
        request.end_headers = lambda: None
        return request

    def upstream(self, status, code, headers=None):
        class Response:
            status_code = status

            def __init__(self):
                self.headers = headers or {}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def json(self):
                return {
                    "error": {
                        "code": code,
                        "message": "private provider account details",
                    }
                }

        return Response()

    def test_rate_limit_retains_hold_and_cooldown_prevents_another_paid_request(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spend.sqlite"
            budget = Budget(path)
            cls = handler(budget, {"test-token": "trial"}, "dummy-test-key")
            response = self.upstream(
                429,
                "rate_limit_exceeded",
                {"Retry-After": "30", "x-request-id": "req-test"},
            )
            with patch("budget_proxy.requests.post", return_value=response) as upstream:
                first = self.request(cls)
                first.do_POST()
                second = self.request(cls)
                second.do_POST()
                self.assertEqual(upstream.call_count, 1)
            self.assertEqual(first.status, 429)
            self.assertEqual(first.response_headers["Retry-After"], "30")
            self.assertEqual(
                json.loads(first.wfile.getvalue())["error"]["code"],
                "rate_limit_exceeded",
            )
            self.assertEqual(second.status, 429)
            self.assertEqual(
                json.loads(second.wfile.getvalue())["error"]["code"],
                "rate_limit_backoff",
            )
            self.assertNotIn(b"private provider", first.wfile.getvalue())
            self.assertEqual(
                budget.summary()["trial"],
                {"requests": 1, "unknown_usage": 1, "usd_upper_bound": 0.5},
            )
            with sqlite3.connect(path) as db:
                self.assertEqual(
                    db.execute(
                        "SELECT http_status,provider_code,request_id,retry_after FROM calls"
                    ).fetchone(),
                    (429, "rate_limit_exceeded", "req-test", "30"),
                )

    def test_cumulative_budget_stop_is_explicit_and_does_not_call_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(Path(directory) / "spend.sqlite", 0.5)
            budget.reserve("previous")
            cls = handler(budget, {"test-token": "trial"}, "dummy-test-key")
            request = self.request(cls)
            with patch("budget_proxy.requests.post") as upstream:
                request.do_POST()
                upstream.assert_not_called()
            self.assertEqual(request.status, 403)
            self.assertEqual(
                json.loads(request.wfile.getvalue())["error"]["code"],
                "pilot_budget_exhausted",
            )
            self.assertNotIn("trial", budget.summary())

    def test_unrecognized_error_is_redacted_and_keeps_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(Path(directory) / "spend.sqlite")
            cls = handler(budget, {"test-token": "trial"}, "dummy-test-key")
            request = self.request(cls)
            with patch(
                "budget_proxy.requests.post",
                return_value=self.upstream(400, "private value with spaces"),
            ):
                request.do_POST()
            self.assertEqual(request.status, 400)
            self.assertEqual(
                json.loads(request.wfile.getvalue())["error"]["code"], "upstream_error"
            )
            self.assertNotIn("Retry-After", request.response_headers)
            self.assertNotIn(b"private", request.wfile.getvalue())
            self.assertEqual(budget.summary()["trial"]["unknown_usage"], 1)

    def test_retry_after_supports_seconds_dates_and_invalid_values(self):
        self.assertEqual(retry_delay("1.2"), 2)
        with patch("budget_proxy.time.time", return_value=0):
            self.assertEqual(retry_delay("Thu, 01 Jan 1970 00:01:00 GMT"), 60)
        for value in (None, "", "invalid", "nan", "inf", "-1"):
            self.assertIsNone(retry_delay(value))

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
