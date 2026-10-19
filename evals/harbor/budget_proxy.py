"""Pilot-only text Chat Completions proxy with a durable, conservative spend ceiling.

Real credentials stay on the operator's host. A scoped bearer token is supplied to
all agents in one trial. No request content or credentials are logged. Unknown
usage retains its full reservation, including after a process crash.
"""

import argparse
import json
import os
import secrets
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

MODEL = "gpt-4.1-mini-2025-04-14"
# USD micro-units. Full 1,047,576-token input at $0.40/M plus 8192 output
# at $1.60/M is < $0.50. Only text and ordinary function tools are allowed.
RESERVATION = 500_000
FULL_MODEL = "gpt-4.1-2025-04-14"


class Budget:
    def __init__(self, path, cap_usd=10, model=MODEL):
        if model not in (MODEL, FULL_MODEL):
            raise ValueError("Unsupported pilot model")
        self.model = model
        self.multiplier = 5 if model == FULL_MODEL else 1
        self.reservation = 2_200_000 if model == FULL_MODEL else RESERVATION
        self.path = str(path)
        self.cap = round(cap_usd * 1_000_000)
        self.lock = threading.Lock()
        with sqlite3.connect(self.path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY, client TEXT, charge INTEGER, usage TEXT)"
            )
        Path(self.path).chmod(0o600)

    def reserve(self, client):
        with self.lock, sqlite3.connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            total = db.execute("SELECT coalesce(sum(charge),0) FROM calls").fetchone()[
                0
            ]
            if total + self.reservation > self.cap:
                raise ValueError("Pilot spend cap reached")
            return db.execute(
                "INSERT INTO calls(client,charge) VALUES(?,?)",
                (client, self.reservation),
            ).lastrowid

    def settle(self, identifier, usage):
        # Unknown/malformed usage must never release a reservation.
        prompt, completion = usage["prompt_tokens"], usage["completion_tokens"]
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        if (
            not all(isinstance(v, int) and v >= 0 for v in (prompt, completion, cached))
            or cached > prompt
        ):
            raise ValueError("Invalid usage")
        # Round UP to microdollars, with integer arithmetic.
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


def handler(budget, tokens, api_key):
    observed_clients = set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, data):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            client = tokens.get(token)
            if not client:
                return self.reply(401, {"error": {"message": "Invalid trial token"}})
            if self.path != "/v1/chat/completions":
                return self.reply(404, {"error": {"message": "Endpoint not allowed"}})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 16_000_000:
                    raise ValueError("Invalid request size")
                payload = validate(json.loads(self.rfile.read(length)), budget.model)
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
                identifier = budget.reserve(client)
            except (ValueError, KeyError, TypeError):
                return self.reply(
                    400,
                    {
                        "error": {
                            "message": "Request rejected or pilot spend cap reached"
                        }
                    },
                )
            usage = None
            started = False
            try:
                with requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    json=payload,
                    headers={"Authorization": "Bearer " + api_key},
                    stream=True,
                    timeout=(15, 180),
                ) as response:
                    if response.status_code != 200:
                        # Conservatively retain the reservation on upstream errors.
                        return self.reply(
                            response.status_code,
                            {
                                "error": {
                                    "message": "Upstream inference error; see provider account"
                                }
                            },
                        )
                    self.send_response(200)
                    self.send_header(
                        "Content-Type",
                        response.headers.get("Content-Type", "application/json"),
                    )
                    self.end_headers()
                    started = True
                    if payload.get("stream"):
                        for line in response.iter_lines():
                            if line.startswith(b"data: ") and line != b"data: [DONE]":
                                event = json.loads(line[6:])
                                usage = event.get("usage") or usage
                            self.wfile.write(line + b"\n")
                            self.wfile.flush()
                    else:
                        data = response.json()
                        usage = data.get("usage")
                        self.wfile.write(json.dumps(data).encode())
            except (requests.RequestException, OSError, ValueError, TypeError):
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
    parser.add_argument("--model", choices=(MODEL, FULL_MODEL), default=MODEL)
    parser.add_argument("--cap-usd", type=float, default=10)
    parser.add_argument("--client", action="append", required=True)
    args = parser.parse_args()
    if not 0 < args.cap_usd <= 10:
        parser.error("Pilot cap must be between $0 and $10")
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
