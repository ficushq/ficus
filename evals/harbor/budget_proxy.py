"""Pilot-only text inference proxy with a durable, conservative spend ceiling.

Real credentials stay on the operator's host. A scoped bearer token is supplied to
all agents in one trial. No request content or credentials are logged. Unknown
usage retains its full reservation, including after a process crash.
"""

import argparse
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import UTC, datetime
from decimal import ROUND_CEILING, Decimal
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

MODEL = "gpt-4.1-mini-2025-04-14"
# USD micro-units. Full 1,047,576-token input at $0.40/M plus 8192 output
# at $1.60/M is < $0.50. Only text and ordinary function tools are allowed.
RESERVATION = 500_000
FULL_MODEL = "gpt-4.1-2025-04-14"
SOL_MODEL = "gpt-6.1-sol"
# Full 1.05M context at the highest Standard cache-write rate ($5/M
# above 272K), plus 8192 output at $15/M, is below $5.50.
SOL_RESERVATION = 5_500_000


class SpendCapReached(ValueError):
    pass


class Budget:
    def __init__(self, path, cap_usd=10, model=MODEL):
        if model not in (MODEL, FULL_MODEL, SOL_MODEL):
            raise ValueError("Unsupported pilot model")
        self.model = model
        self.multiplier = 5 if model == FULL_MODEL else 1
        self.reservation = (
            SOL_RESERVATION
            if model == SOL_MODEL
            else 2_200_000
            if model == FULL_MODEL
            else RESERVATION
        )
        self.path = str(path)
        self.cap = round(cap_usd * 1_000_000)
        self.lock = threading.Lock()
        with sqlite3.connect(self.path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY, client TEXT, charge INTEGER, usage TEXT)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS reconciliations(through_call INTEGER PRIMARY KEY, upper_bound INTEGER NOT NULL, confirmed INTEGER NOT NULL, raw_exposure INTEGER NOT NULL, evidence TEXT NOT NULL, recorded_at TEXT NOT NULL)"
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(calls)")}
            for name, kind in (
                ("http_status", "INTEGER"),
                ("failure", "TEXT"),
                ("model", "TEXT"),
                ("provider_code", "TEXT"),
                ("request_id", "TEXT"),
                ("retry_after", "TEXT"),
            ):
                if name not in columns:
                    db.execute(f"ALTER TABLE calls ADD COLUMN {name} {kind}")
        Path(self.path).chmod(0o600)

    def reserve(self, client):
        with self.lock, sqlite3.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            total = self.exposure(db)
            if total + self.reservation > self.cap:
                raise SpendCapReached("Pilot spend cap reached")
            return db.execute(
                "INSERT INTO calls(client,charge,model) VALUES(?,?,?)",
                (client, self.reservation, self.model),
            ).lastrowid

    @staticmethod
    def exposure(db):
        checkpoint = db.execute(
            "SELECT through_call,upper_bound FROM reconciliations ORDER BY through_call DESC LIMIT 1"
        ).fetchone()
        cutoff, baseline = checkpoint or (0, 0)
        return (
            baseline
            + db.execute(
                "SELECT coalesce(sum(charge),0) FROM calls WHERE id>?", (cutoff,)
            ).fetchone()[0]
        )

    def reconcile(self, total_usd, evidence):
        """Operator-only checkpoint; stop all inference first. Never rewrites calls.

        Supply a conservative provider total covering every call to date, with
        evidence and rounding/delay margin. The checkpoint includes metered calls,
        unresolved calls, and any other account spend included by the provider.
        """
        amount = Decimal(str(total_usd))
        if not amount.is_finite() or amount < 0 or not evidence.strip():
            raise ValueError("A finite provider total and evidence are required")
        upper = int((amount * 1_000_000).to_integral_value(rounding=ROUND_CEILING))
        with self.lock, sqlite3.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            cutoff, confirmed, raw = db.execute(
                "SELECT max(id),coalesce(sum(CASE WHEN usage IS NOT NULL THEN charge ELSE 0 END),0),coalesce(sum(charge),0) FROM calls"
            ).fetchone()
            if cutoff is None or upper < confirmed:
                raise ValueError("Provider total cannot be below confirmed usage")
            db.execute(
                "INSERT INTO reconciliations VALUES(?,?,?,?,?,?)",
                (
                    cutoff,
                    upper,
                    confirmed,
                    raw,
                    evidence,
                    datetime.now(UTC).isoformat(),
                ),
            )
        return {"through_call": cutoff, "usd_upper_bound": upper / 1e6}

    def total(self):
        with sqlite3.connect(self.path) as db:
            return self.exposure(db) / 1e6

    def settle(self, identifier, usage):
        # Unknown/malformed usage must never release a reservation.
        if self.model == SOL_MODEL:
            prompt, completion = usage["input_tokens"], usage["output_tokens"]
            details = usage.get("input_tokens_details") or {}
            cached = details.get("cached_tokens", 0)
            # If a receipt omits the new field, charge the remaining input at
            # cache-write rates conservatively, rather than undercounting it.
            written = details.get("cache_write_tokens", prompt - cached)
            values = (prompt, completion, cached, written)
            if (
                not all(type(v) is int and v >= 0 for v in values)
                or cached + written > prompt
            ):
                raise ValueError("Invalid Responses usage")
            input_rate, output_rate = (2, 15) if prompt > 272_000 else (1, 10)
            charge = (
                ((prompt - cached - written) * 20 + cached + written * 25) * input_rate
                + completion * output_rate * 10
                + 9
            ) // 10
        else:
            prompt, completion = usage["prompt_tokens"], usage["completion_tokens"]
            cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
            if (
                not all(type(v) is int and v >= 0 for v in (prompt, completion, cached))
                or cached > prompt
            ):
                raise ValueError("Invalid usage")
            charge = (
                ((prompt - cached) * 4 + cached + completion * 16) * self.multiplier + 9
            ) // 10
        if charge > self.reservation:
            raise ValueError("Unexpected usage exceeds conservative reservation")
        with self.lock, sqlite3.connect(self.path) as db:
            db.execute(
                "UPDATE calls SET charge=?, usage=? WHERE id=?",
                (charge, json.dumps(usage), identifier),
            )

    def note(
        self,
        identifier,
        *,
        status=None,
        failure=None,
        provider_code=None,
        request_id=None,
        retry_after=None,
    ):
        with self.lock, sqlite3.connect(self.path) as db:
            db.execute(
                "UPDATE calls SET http_status=coalesce(?,http_status), failure=coalesce(?,failure), provider_code=coalesce(?,provider_code), request_id=coalesce(?,request_id), retry_after=coalesce(?,retry_after) WHERE id=?",
                (status, failure, provider_code, request_id, retry_after, identifier),
            )

    def summary(self):
        with sqlite3.connect(self.path) as db:
            return {
                client: {
                    "usd_upper_bound": charge / 1e6,
                    "requests": count,
                    "unknown_usage": unknown,
                }
                for client, charge, count, unknown in db.execute(
                    "SELECT client,sum(charge),count(*),sum(usage IS NULL) FROM calls GROUP BY client"
                )
            }


def validate(payload, model=MODEL):
    if payload.get("model") != model or payload.get("n", 1) != 1:
        raise ValueError("Only the pinned pilot model and n=1 are allowed")
    if any(
        key in payload
        for key in ("audio", "modalities", "prediction", "web_search_options")
    ):
        raise ValueError("Only text inference is allowed")
    for message in payload.get("messages", []):
        content = message.get("content")
        if isinstance(content, list) and any(
            part.get("type") != "text" for part in content
        ):
            raise ValueError("Only text message content is allowed")
    if any(tool.get("type") != "function" for tool in payload.get("tools", [])):
        raise ValueError("Only client-side function tools are allowed")
    payload.pop("service_tier", None)
    payload.pop("max_tokens", None)
    payload["max_completion_tokens"] = min(
        int(payload.get("max_completion_tokens", 8192)), 8192
    )
    if payload.get("stream"):
        payload["stream_options"] = {"include_usage": True}
    return payload


def validate_responses(payload):
    """Permit only stateless text/function inference through Pi's native transport."""
    allowed = {
        "model",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "stream",
        "max_output_tokens",
        "reasoning",
        "include",
        "store",
        "background",
        "service_tier",
        "parallel_tool_calls",
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
        "text",
    }
    if set(payload) - allowed or payload.get("model") != SOL_MODEL:
        raise ValueError("Unsupported Responses request")
    if payload.get("store") or payload.get("background"):
        raise ValueError("Only foreground stateless inference is allowed")
    items = payload.get("input", [])
    if not isinstance(items, (str, list)):
        raise TypeError("Invalid input")
    for item in items if isinstance(items, list) else []:
        kind = item.get("type", "message")
        if kind not in {
            "message",
            "function_call",
            "function_call_output",
            "reasoning",
        }:
            raise ValueError("Only text and client-side function history allowed")
        if kind == "message":
            content = item.get("content", "")
            if not isinstance(content, (str, list)):
                raise ValueError("Invalid message content")
            if isinstance(content, list) and any(
                part.get("type") not in {"input_text", "output_text"}
                for part in content
            ):
                raise ValueError("Only text input allowed")
        if kind == "function_call_output" and not isinstance(item.get("output"), str):
            raise ValueError("Only text function outputs allowed")
    if any(tool.get("type") != "function" for tool in payload.get("tools", [])):
        raise ValueError("Only client-side functions allowed")
    limit = payload.get("max_output_tokens", 8192)
    if type(limit) is not int or limit < 16:
        raise ValueError("Invalid output token limit")
    payload["max_output_tokens"] = min(limit, 8192)
    reasoning = payload.get("reasoning") or {}
    if reasoning.get("effort", "medium") != "medium":
        raise ValueError("This configuration pins medium reasoning")
    payload["reasoning"] = {**reasoning, "effort": "medium"}
    payload["service_tier"] = "default"
    payload["store"] = False
    payload["background"] = False
    payload.pop("prompt_cache_retention", None)
    return payload


def response_usage(event):
    if event.get("type") in {
        "response.completed",
        "response.incomplete",
        "response.failed",
    }:
        return (event.get("response") or {}).get("usage")
    return None


def retry_delay(value):
    """Honor numeric or HTTP-date Retry-After without copying arbitrary headers."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            return None
    return (
        max(1, math.ceil(seconds)) if math.isfinite(seconds) and seconds > 0 else None
    )


def handler(budget, tokens, api_key):
    observed_clients = set()
    cooldown_lock = threading.Lock()
    cooldown_until = 0.0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, data, retry_after=None):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            nonlocal cooldown_until
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            client = tokens.get(token)
            if not client:
                return self.reply(401, {"error": {"message": "Invalid trial token"}})
            endpoint = (
                "/v1/responses" if budget.model == SOL_MODEL else "/v1/chat/completions"
            )
            if self.path != endpoint:
                return self.reply(404, {"error": {"message": "Endpoint not allowed"}})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 16_000_000:
                    raise ValueError("Invalid request size")
                raw = json.loads(self.rfile.read(length))
                payload = (
                    validate_responses(raw)
                    if budget.model == SOL_MODEL
                    else validate(raw, budget.model)
                )
                if client not in observed_clients:
                    observed_clients.add(client)
                    system = "\n".join(
                        str(m.get("content", ""))
                        for m in payload.get("messages", [])
                        if m.get("role") in ("system", "developer")
                    )
                    print(
                        json.dumps(
                            {
                                "client": client,
                                "system_prompt_chars": len(system),
                                "squad_contract_present": "Run this task through your squad"
                                in system,
                            }
                        ),
                        flush=True,
                    )
                with cooldown_lock:
                    delay = max(0, math.ceil(cooldown_until - time.monotonic()))
                if delay:
                    return self.reply(
                        429,
                        {
                            "error": {
                                "code": "rate_limit_backoff",
                                "message": "Provider cooldown is active; retry after the specified delay",
                            }
                        },
                        retry_after=delay,
                    )
                identifier = budget.reserve(client)
            except SpendCapReached:
                return self.reply(
                    403,
                    {
                        "error": {
                            "code": "pilot_budget_exhausted",
                            "message": "Cumulative pilot spend cap reached",
                        }
                    },
                )
            except (ValueError, KeyError, TypeError, AttributeError):
                return self.reply(
                    400,
                    {"error": {"message": "Invalid pilot request"}},
                )
            usage = None
            started = False
            try:
                with requests.post(
                    "https://api.openai.com" + endpoint,
                    json=payload,
                    headers={"Authorization": "Bearer " + api_key},
                    stream=True,
                    timeout=(15, 180),
                ) as response:
                    request_id = response.headers.get("x-request-id", "")[:128]
                    retry_after = response.headers.get("Retry-After", "")[:128]
                    budget.note(
                        identifier,
                        status=response.status_code,
                        request_id=request_id,
                        retry_after=retry_after,
                    )
                    if response.status_code != 200:
                        # No usage receipt: retain the reservation, even for a known rejection.
                        code = None
                        try:
                            error = response.json().get("error", {})
                            value = (
                                error.get("code") if isinstance(error, dict) else None
                            )
                            if isinstance(value, str) and re.fullmatch(
                                r"[a-zA-Z0-9_.-]{1,80}", value
                            ):
                                code = value
                        except (ValueError, AttributeError):
                            pass
                        budget.note(identifier, provider_code=code)
                        delay = retry_delay(retry_after)
                        if response.status_code == 429 and code in {
                            "rate_limit_exceeded",
                            "slow_down",
                        }:
                            delay = delay or 10
                        if response.status_code in {429, 503} and delay:
                            with cooldown_lock:
                                cooldown_until = max(
                                    cooldown_until, time.monotonic() + delay
                                )
                        return self.reply(
                            response.status_code,
                            {
                                "error": {
                                    "code": code or "upstream_error",
                                    "message": "Upstream inference error; see provider account",
                                }
                            },
                            retry_after=delay,
                        )
                    self.send_response(200)
                    self.send_header(
                        "Content-Type",
                        response.headers.get("Content-Type", "application/json"),
                    )
                    self.end_headers()
                    started = True
                    disconnected = False
                    if payload.get("stream"):
                        for line in response.iter_lines():
                            if line.startswith(b"data: ") and line != b"data: [DONE]":
                                event = json.loads(line[6:])
                                usage = (
                                    response_usage(event)
                                    if budget.model == SOL_MODEL
                                    else event.get("usage")
                                ) or usage
                            if not disconnected:
                                try:
                                    self.wfile.write(line + b"\n")
                                    self.wfile.flush()
                                except OSError:
                                    # The provider can finish billing after the client leaves.
                                    # Drain to the final usage chunk rather than losing evidence.
                                    disconnected = True
                                    budget.note(
                                        identifier, failure="client_disconnected"
                                    )
                    else:
                        data = response.json()
                        usage = data.get("usage")
                        self.wfile.write(json.dumps(data).encode())
            except (requests.RequestException, OSError, ValueError, TypeError) as error:
                budget.note(identifier, failure=type(error).__name__)
                if not started:
                    self.reply(502, {"error": {"message": "Inference unavailable"}})
            finally:
                if usage:
                    budget.settle(identifier, usage)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument(
        "--model", choices=(MODEL, FULL_MODEL, SOL_MODEL), default=MODEL
    )
    parser.add_argument("--cap-usd", type=float, default=10)
    parser.add_argument("--client", action="append", required=True)
    args = parser.parse_args()
    if not 0 < args.cap_usd <= 20:
        parser.error("Pilot cap must be between $0 and $20")
    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    api_key = os.environ.pop("OPENAI_API_KEY")
    tokens = {secrets.token_urlsafe(32): client for client in args.client}
    budget = Budget(args.state / "spend.sqlite", args.cap_usd, args.model)
    server = ThreadingHTTPServer(
        ("0.0.0.0", args.port), handler(budget, tokens, api_key)
    )
    config = args.state / "access.json"
    config.touch(mode=0o600)
    config.write_text(
        json.dumps(
            {
                "port": server.server_port,
                "model": args.model,
                "model_api": "openai-responses"
                if args.model == SOL_MODEL
                else "openai-completions",
                "thinking": "medium" if args.model == SOL_MODEL else "off",
                "clients": {v: k for k, v in tokens.items()},
            }
        )
    )
    print(
        f"Budget proxy ready on port {server.server_port}; cap ${args.cap_usd:.2f}",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()
        print(json.dumps(budget.summary()), flush=True)


if __name__ == "__main__":
    main()
