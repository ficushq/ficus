"""Native persistent three-request evaluation; host keeps future requests private."""

import hashlib
import json
from pathlib import Path
import shlex
import tempfile
import time

from coordination import (
    BOOTSTRAP,
    FicusCoordination,
    PiCoordination,
    PiCoordinationOptions,
)
from coordination_bookkeeping import BOOKKEEPING
from ficus_agent import ROOT, RUNTIME, FicusSquad
from harbor.agents.installed.pi import Pi
from longitudinal_bootstrap import render


CONTRACT = """Work on this product increment in the existing /app repository.
You are the coordinator, not the implementer. Delegate design to an architect,
implementation/integration to engineers, and independent validation to reviewers.
Choose an appropriate work breakdown for this increment; preserve earlier delivered
requirements unless this request explicitly changes them. Never implement or
self-approve as coordinator. Use at most two concurrent workers and establish
branch/worktree or disjoint-file ownership before parallel edits. Deliver all
required files committed in /app, not only on worker branches. Obtain independent
approval of the final integrated product before reporting completion.
Preserve every received original request verbatim in an accessible durable source;
include its path in every assignment. Plans supplement, never replace, that source.
Use your existing history and durable notes/memory when useful, and update them
with reusable decisions. Do not store credentials or other sensitive information.
Keep factual package/ownership/dependency/review/commit records in COORDINATION.md.
No human clarifications, remote PRs or deployments are available; investigate and
document reasonable choices. No benchmark tests or reference solutions are available.
Only the current request is supplied. Do not guess or implement future requests.
"""


def handoff(request, harness, index):
    mechanics = (
        "Use the same native Ficus squad and saved planning/engineering/review workflow.\n"
        if harness == "ficus"
        else "Use the packaged architect/engineer/reviewer subagent roles; retain this coordinator session.\n"
    )
    return (
        CONTRACT
        + mechanics
        + BOOKKEEPING
        + f"\nPRODUCT INCREMENT {index}\nBEGIN REQUEST\n"
        + request
        + "\nEND REQUEST"
    )


def load_requests(path, expected):
    path = Path(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError("Sequential request manifest hash mismatch")
    data = json.loads(path.read_text())
    if data.get("version") != 1 or len(data.get("requests", [])) != 3:
        raise ValueError("Expected exactly three frozen requests")
    if not all(isinstance(r, str) and r.strip() for r in data["requests"]):
        raise ValueError("Invalid request text")
    return data["requests"]


def validate_pi_increment(current, previous=b""):
    if previous and not current.startswith(previous):
        raise RuntimeError("Pi session history was rewritten between increments")
    events = [
        json.loads(line)
        for line in current[len(previous) :].splitlines()
        if line.strip()
    ]
    messages = [e.get("message", {}) for e in events if e.get("type") == "message"]
    assistants = [m for m in messages if m.get("role") == "assistant"]
    if not assistants or assistants[-1].get("stopReason") != "stop":
        raise RuntimeError(
            "Pi increment did not end with a successful native final response"
        )
    roles = set()
    for message in messages:
        if message.get("role") != "toolResult" or message.get("toolName") != "subagent":
            continue
        for result in (message.get("details") or {}).get("results", []):
            if (
                result.get("exitCode") == 0
                and (result.get("usage") or {}).get("turns", 0) > 0
            ):
                roles.add(result.get("agent"))
    if not {"architect", "engineer", "reviewer"}.issubset(roles):
        raise RuntimeError("Pi increment omitted a required native role")
    return sorted(roles)


async def capture_stage(environment, logs_dir, index):
    # No tests, hints, source rewrites or commits. Export committed delivery only.
    prefix = f"/logs/artifacts/increment-{index}"
    code = (
        'cd /app && test -z "$(git status --porcelain=v1)" && mkdir -p /logs/artifacts && '
        f"test ! -e {prefix}.patch && git diff --binary baseline HEAD > {prefix}.patch && "
        f"git rev-parse HEAD > {prefix}.head && git bundle create {prefix}.bundle --all"
    )
    result = await environment.exec(code, user="root", timeout_sec=90)
    if result.return_code:
        raise RuntimeError(
            "Increment lacks a clean committed delivery or snapshot failed"
        )
    stage = Path(logs_dir) / f"increment-{index}"
    stage.mkdir(exist_ok=False)
    for suffix in ["patch", "head", "bundle"]:
        await environment.download_file(
            f"{prefix}.{suffix}", stage / f"repository.{suffix}"
        )
    return {
        "increment": index,
        "captured_at_unix": time.time(),
        "head": (stage / "repository.head").read_text().strip(),
        "patch_sha256": hashlib.sha256(
            (stage / "repository.patch").read_bytes()
        ).hexdigest(),
        "clean": True,
    }


class FicusLongitudinal(FicusCoordination):
    def __init__(self, *args, requests_manifest, requests_sha256, **kwargs):
        self.requests = load_requests(requests_manifest, requests_sha256)
        self.increment = 1
        self.deliveries = []
        super().__init__(*args, **kwargs)

    async def setup(self, environment):
        await super().setup(environment)
        source = render(BOOTSTRAP.read_text())
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "bootstrap.ts"
            p.write_text(source)
            await environment.upload_file(
                p, RUNTIME + "/apps/core/src/scripts/harbor-trial.ts"
            )
        (self.logs_dir / "longitudinal-bootstrap.sha256").write_text(
            hashlib.sha256(source.encode()).hexdigest() + "\n"
        )

    async def on_settled(self, outcome, environment, context):
        if outcome != "delivered":
            return False
        delivery = await capture_stage(environment, self.logs_dir, self.increment)
        for mode, filename in [
            ("snapshot", "snapshot.json"),
            ("export", "messages.json"),
            ("memory-export", "memory.json"),
        ]:
            await self.bootstrap_command(environment, mode, filename)
            await environment.download_file(
                ROOT + "/" + filename,
                self.logs_dir / f"increment-{self.increment}" / filename,
            )
        self.deliveries.append(delivery)
        (self.logs_dir / "increment-deliveries.json").write_text(
            json.dumps(self.deliveries, indent=2) + "\n"
        )
        if self.increment == len(self.requests):
            return False
        self.increment += 1
        await self.upload_json(
            environment,
            ROOT + "/next-request.json",
            {
                "round": self.increment,
                "instruction": handoff(
                    self.requests[self.increment - 1], "ficus", self.increment
                ),
            },
        )
        await self.bootstrap_command(
            environment, "follow-up", f"increment-{self.increment}-identity.json"
        )
        await self.checked(environment, f"rm {ROOT}/next-request.json")
        return True

    async def run(self, instruction, environment, context):
        if instruction != self.requests[0]:
            raise ValueError(
                "Harbor first instruction does not match frozen first request"
            )
        self.coordination_instruction = handoff(instruction, "ficus", 1)
        try:
            await FicusSquad.run(self, instruction, environment, context)
        finally:
            context.metadata = {
                **(context.metadata or {}),
                "study": "longitudinal-v1",
                "increments_delivered": len(self.deliveries),
                "memory": "persistent-native-keyword-no-embedding-provider",
                "same_database_and_manager": True,
            }


class PiLongitudinalOptions(PiCoordinationOptions):
    requests_manifest: str
    requests_sha256: str


class PiLongitudinal(PiCoordination):
    options_model = PiLongitudinalOptions

    def __init__(self, *args, requests_manifest, requests_sha256, **kwargs):
        self.requests = load_requests(requests_manifest, requests_sha256)
        super().__init__(
            *args,
            requests_manifest=requests_manifest,
            requests_sha256=requests_sha256,
            **kwargs,
        )

    async def run(self, instruction, environment, context):
        if instruction != self.requests[0]:
            raise ValueError(
                "Harbor first instruction does not match frozen first request"
            )
        deliveries = []
        session_name = None
        previous = b""
        try:
            for index, request in enumerate(self.requests, 1):
                self._resume = index > 1
                await Pi.run(self, handoff(request, "pi", index), environment, context)
                session_root = str(self.environment_logs_dir / self._SESSIONS_DIRECTORY)
                result = await self.exec_as_agent(
                    environment,
                    command=f"find {shlex.quote(session_root)} -maxdepth 1 -name '*.jsonl' -type f",
                )
                names = (result.stdout or "").splitlines()
                if (
                    result.return_code
                    or len(names) != 1
                    or (session_name is not None and names[0] != session_name)
                ):
                    raise RuntimeError("Pi coordinator session was not preserved")
                session_name = names[0]
                # Validate only public session metadata; never inspect hidden reasoning.
                checkpoint = self.logs_dir / f"pending-session-{index}.jsonl"
                await environment.download_file(session_name, checkpoint)
                current = checkpoint.read_bytes()
                roles = validate_pi_increment(current, previous)
                previous = current
                delivery = await capture_stage(environment, self.logs_dir, index)
                checkpoint.rename(
                    self.logs_dir / f"increment-{index}" / "coordinator-session.jsonl"
                )
                delivery["native_roles_executed"] = roles
                delivery["coordinator_session"] = Path(session_name).name
                deliveries.append(delivery)
                (self.logs_dir / "increment-deliveries.json").write_text(
                    json.dumps(deliveries, indent=2) + "\n"
                )
        finally:
            self._resume = False
            context.metadata = {
                **(context.metadata or {}),
                "study": "longitudinal-v1",
                "increments_delivered": len(deliveries),
                "memory": "persistent-coordinator-session-and-files",
                "same_coordinator_session": session_name,
            }
