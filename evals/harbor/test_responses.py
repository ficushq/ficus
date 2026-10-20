import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_adapter as helpers
from budget_proxy import SOL_MODEL, SOL_RESERVATION, Budget, handler, validate_responses


class ResponsesTests(unittest.TestCase):
    def test_rejects_hidden_state_hosted_tools_media_and_reasoning_mismatch(self):
        for extra in (
            {"previous_response_id": "resp_x"},
            {"conversation": "c"},
            {"tools": [{"type": "web_search"}]},
            {"background": True},
            {"input": [{"role": "user", "content": [{"type": "input_image"}]}]},
            {
                "input": [
                    {
                        "type": "function_call_output",
                        "output": [{"type": "input_image"}],
                    }
                ]
            },
            {"reasoning": {"effort": "low"}},
            {"max_output_tokens": -1},
        ):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                validate_responses({"model": SOL_MODEL, **extra})
        result = validate_responses(
            {
                "model": SOL_MODEL,
                "service_tier": "ultrafast",
                "max_output_tokens": 999999,
            }
        )
        self.assertEqual(result["service_tier"], "default")
        self.assertEqual(result["max_output_tokens"], 8192)
        self.assertEqual(result["reasoning"]["effort"], "medium")
        self.assertFalse(result["store"])

    def test_cache_writes_long_context_and_missing_field_accounting(self):
        with tempfile.TemporaryDirectory() as directory:
            budget = Budget(Path(directory) / "ledger", 20, SOL_MODEL)
            call = budget.reserve("test")
            budget.settle(
                call,
                {
                    "input_tokens": 100000,
                    "output_tokens": 1000,
                    "input_tokens_details": {
                        "cached_tokens": 20000,
                        "cache_write_tokens": 30000,
                    },
                },
            )
            self.assertAlmostEqual(budget.total(), 0.187)
            call = budget.reserve("test")
            budget.settle(
                call,
                {
                    "input_tokens": 300000,
                    "output_tokens": 1000,
                    "input_tokens_details": {
                        "cached_tokens": 100000,
                        "cache_write_tokens": 100000,
                    },
                },
            )
            self.assertAlmostEqual(budget.total(), 0.187 + 0.935)
            call = budget.reserve("test")
            budget.settle(call, {"input_tokens": 1000, "output_tokens": 0})
            self.assertAlmostEqual(budget.total(), 0.187 + 0.935 + 0.0025)
            call = budget.reserve("invalid")
            with self.assertRaises(ValueError):
                budget.settle(
                    call,
                    {
                        "input_tokens": 100,
                        "output_tokens": 1,
                        "input_tokens_details": {
                            "cached_tokens": 80,
                            "cache_write_tokens": 80,
                        },
                    },
                )
            self.assertEqual(budget.summary()["invalid"]["unknown_usage"], 1)
            self.assertEqual(
                budget.summary()["invalid"]["usd_upper_bound"], SOL_RESERVATION / 1e6
            )

    def test_sse_terminal_usage_is_settled_for_completed_and_incomplete(self):
        for kind in ("response.completed", "response.incomplete"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                budget = Budget(Path(directory) / "ledger", 20, SOL_MODEL)
                cls = handler(budget, {"test-token": "trial"}, "fake-key")
                request = helpers.ProxyTests().request(cls)
                body = json.dumps(
                    {"model": SOL_MODEL, "input": "test", "stream": True}
                ).encode()
                request.path = "/v1/responses"
                request.headers["Content-Length"] = str(len(body))
                request.rfile = io.BytesIO(body)
                response = helpers.ProxyTests().upstream(
                    200, None, {"Content-Type": "text/event-stream"}
                )
                event = {
                    "type": kind,
                    "response": {
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 20,
                            "input_tokens_details": {
                                "cached_tokens": 0,
                                "cache_write_tokens": 0,
                            },
                        }
                    },
                }
                response.iter_lines = lambda kind=kind, event=event: iter(
                    [
                        b"event: " + kind.encode(),
                        b"data: " + json.dumps(event).encode(),
                        b"",
                    ]
                )
                with patch("budget_proxy.requests.post", return_value=response) as post:
                    request.do_POST()
                self.assertEqual(
                    post.call_args.args[0], "https://api.openai.com/v1/responses"
                )
                self.assertAlmostEqual(budget.total(), 0.0004)
                self.assertEqual(budget.summary()["trial"]["unknown_usage"], 0)
                self.assertIn(kind.encode(), request.wfile.getvalue())

    def test_stream_failure_under_http_200_is_forwarded_recorded_and_stops_reading(
        self,
    ):
        for kind in ("error", "response.failed"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                budget = Budget(Path(directory) / "ledger", 20, SOL_MODEL)
                cls = handler(budget, {"test-token": "trial"}, "fake-key")
                request = helpers.ProxyTests().request(cls)
                body = json.dumps(
                    {"model": SOL_MODEL, "input": "test", "stream": True}
                ).encode()
                request.path = "/v1/responses"
                request.headers["Content-Length"] = str(len(body))
                request.rfile = io.BytesIO(body)
                error = {"code": "insufficient_quota", "message": "No credits remain"}
                event = (
                    {"type": kind, **error}
                    if kind == "error"
                    else {"type": kind, "response": {"error": error, "usage": None}}
                )
                response = helpers.ProxyTests().upstream(
                    200, None, {"Content-Type": "text/event-stream"}
                )

                def events():
                    yield b"event: " + kind.encode()
                    yield b"data: " + json.dumps(event).encode()
                    raise AssertionError(
                        "Must close after the terminal failure, not wait for another chunk"
                    )

                response.iter_lines = events
                with patch("budget_proxy.requests.post", return_value=response):
                    request.do_POST()
                self.assertEqual(budget.total(), SOL_RESERVATION / 1e6)
                self.assertEqual(budget.summary()["trial"]["unknown_usage"], 1)
                self.assertTrue(request.wfile.getvalue().endswith(b"\n\n"))
                import sqlite3

                with sqlite3.connect(budget.path) as db:
                    self.assertEqual(
                        db.execute(
                            "SELECT http_status,failure,provider_code,usage FROM calls"
                        ).fetchone(),
                        (200, "upstream_stream_error", "insufficient_quota", None),
                    )

    def test_stream_error_codes_are_sanitized_without_persisting_messages(self):
        from budget_proxy import stream_failure

        self.assertEqual(
            stream_failure(
                {"type": "error", "code": "private value / token", "message": "private"}
            ),
            "upstream_stream_error",
        )
        self.assertIsNone(
            stream_failure({"type": "response.incomplete", "response": {"usage": None}})
        )
