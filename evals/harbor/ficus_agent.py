"""Full Ficus squad adapter for Harbor 0.24.0. Official tasks and verifiers stay owned by Harbor."""

import asyncio
import hashlib
import json
import re
import secrets
import shlex
import tempfile
import time
import uuid
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext

ROOT = "/opt/ficus-harbor"
RUNTIME = ROOT + "/runtime"
ACTIVE = {"queued", "waiting-maintenance", "waiting-sandbox", "running", "stopping"}


def squad_handoff(instruction, workflow="reviewed"):
    """Keep task text verbatim while making the requested execution mode explicit."""
    if workflow == "engineer":
        return instruction
    workflow_flag = "--workflow builder-reviewer " if workflow == "reviewed" else ""
    planning = (
        " Include the architect planning stage before implementation."
        if workflow == "planned"
        else ""
    )
    return (
        "Complete the task below through a full Ficus squad with independent review.\n\n"
        "BEGIN TASK\n" + instruction + "\nEND TASK\n\n"
        "Execution contract: you are the manager, not the implementer. Before investigating "
        "or changing task files, use squad_bash to create a work stream with "
        "`ficus workstream create <title> --squad <your-squad-id> --owner <your-agent-id> "
        + workflow_flag
        + "-d <self-contained-description>`. Your IDs are in "
        "your system context; consult CLI help if needed. Include the complete task, "
        "the exact workspace path, and the user's authorization for in-place changes "
        "in this disposable, single-task workspace. Omit repository/branch/worktree "
        "provisioning flags: this workspace already supplies isolation. Let the flow "
        "run its engineer and independent reviewer; coordinate blockers and rework. "
        "Do not implement the task yourself or replace independent review with a "
        "manager self-check, even if the task looks small. No human is available: "
        "delegate investigation of ambiguity to the engineer. Deliver the final files "
        "in the original workspace without GitHub, a PR, or remote deployment."
        + planning
    )


def disposition(snapshot):
    """A quiet manager is not completion while its delegated work is still active."""
    turns = snapshot["executions"]
    if snapshot.get("pendingMessages"):
        return None
    if not turns or any(turn["status"] in ACTIVE for turn in turns):
        return None
    if any(agent["status"] == "waiting-input" for agent in snapshot["agents"]):
        return "waiting-for-human"
    streams = snapshot["streams"]
    if streams and all(stream["status"] == "done" for stream in streams):
        return "delivered"
    if any(stream["status"] in {"active", "queued"} for stream in streams):
        return None
    return "canceled" if streams else "settled-without-work-stream"


async def docker(*args, check=True):
    process = await asyncio.create_subprocess_exec(
        "docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=180)
    except BaseException:
        process.kill()
        await process.wait()
        raise
    if check and process.returncode:
        raise RuntimeError(f"Docker {args[0]} failed: {stderr.decode()[:1500]}")
    return stdout.decode().strip()


class FicusSquad(BaseAgent):
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)
    DEFAULT_SETUP_TIMEOUT_SEC = 900.0

    def __init__(
        self,
        *args,
        runtime_archive=None,
        model_api="openai-completions",
        workflow="reviewed",
        database_network="private",
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if not runtime_archive:
            raise ValueError(
                "Pass --ak runtime_archive=/absolute/path/ficus-runtime.tar.gz"
            )
        if model_api not in {"openai-completions", "openai-responses"}:
            raise ValueError("Unsupported model transport")
        self.model_api = model_api
        if workflow not in {"engineer", "reviewed", "planned"}:
            raise ValueError("Unsupported trial workflow")
        if database_network not in {"private", "task"}:
            raise ValueError("database_network must be private or task")
        self.database_network = database_network
        self.workflow = workflow
        self.archive = Path(runtime_archive).resolve(strict=True)
        self.network = "ficus-harbor-" + uuid.uuid4().hex[:12]
        self.database = "ficus-harbor-db-" + uuid.uuid4().hex[:12]
        self.container = None
        self.env = {}
        self.snapshot = None
        self.last_observation = None
        with self.archive.open("rb") as archive:
            self.archive_sha = hashlib.file_digest(archive, "sha256").hexdigest()

    @property
    def database_host(self):
        return "127.0.0.1" if self.database_network == "task" else self.database

    def database_network_args(self):
        # Sharing the task namespace keeps DB traffic on loopback and preserves
        # Harbor's no-network/allowlist enforcement. Do not attach another
        # outbound-capable network to a restricted task.
        if self.database_network == "task":
            return [
                "--network",
                f"container:{self.container}",
                "--cpus",
                "0.5",
                "--memory",
                "512m",
                "--memory-swap",
                "512m",
            ]
        return ["--network", self.network]

    @staticmethod
    def name():
        return "ficus-squad"

    def version(self):
        # The exact source commit is also recorded in runtime-revision.json.
        return self.archive_sha

    async def checked(self, environment, command, **kwargs):
        result = await environment.exec(command, **kwargs)
        if result.return_code:
            raise RuntimeError(
                f"Ficus runtime command failed ({result.return_code}): {(result.stderr or result.stdout or '')[-2000:]}"
            )
        return result.stdout or ""

    async def upload_json(self, environment, destination, payload):
        with tempfile.TemporaryDirectory(prefix="ficus-harbor-input-") as directory:
            path = Path(directory) / "input.json"
            path.write_text(json.dumps(payload))
            path.chmod(0o600)
            await environment.upload_file(path, destination)
        await self.checked(
            environment, f"chmod 600 {shlex.quote(destination)}", user="root"
        )

    async def setup(self, environment: BaseEnvironment):
        if not isinstance(environment, DockerEnvironment):
            raise TypeError(
                "The first Ficus adapter supports Harbor's local Docker environment only"
            )
        if environment.default_user not in (None, "root", "0", 0):
            raise ValueError(
                "This adapter currently requires a root task user; refusing to change the task's user"
            )
        if self.mcp_servers or self.skills_dir:
            raise ValueError(
                "Task-supplied MCP/skills are not supported by this adapter yet"
            )
        await self.checked(
            environment,
            "test ! -e /opt/ficus-harbor && mkdir -p /opt/ficus-harbor",
            user="root",
        )
        await environment.upload_file(self.archive, ROOT + "/runtime.tar.gz")
        await self.checked(
            environment,
            f"tar -xzf {ROOT}/runtime.tar.gz -C /opt && rm {ROOT}/runtime.tar.gz",
            timeout_sec=180,
            user="root",
        )
        await self.checked(
            environment,
            "command -v apt-get >/dev/null && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git curl bash tmux procps ca-certificates util-linux",
            timeout_sec=180,
            user="root",
        )
        self.workspace = (await self.checked(environment, "pwd")).strip()
        # Use the container's own ID, not a global Docker name or an existing Ficus instance.
        hostname = (await self.checked(environment, "cat /etc/hostname")).strip()
        if not re.fullmatch(r"[0-9a-f]{12,64}", hostname):
            raise ValueError("Expected the task container ID as its hostname")
        self.container = (
            await docker("inspect", "--format", "{{.Id}}", hostname)
        ).strip()
        task_path = (await self.checked(environment, 'printf "%s" "$PATH"')).strip()
        self.env = {
            "FICUS_HARBOR_TRIAL": "1",
            "FICUS_SANDBOX_RUNTIME": "host",
            "FICUS_ROOT": RUNTIME,
            "HOME_DIR": ROOT + "/data",
            "PORT": "17300",
            "WORKER_PORT": "17302",
            "FICUS_WORKER_EVENT_PORT": "17303",
            "APP_URL": "http://127.0.0.1:17300",
            "FICUS_SERVE_WEB": "0",
            "FICUS_ENCRYPTION_KEY": secrets.token_hex(32),
            "FICUS_PASSWORD": secrets.token_hex(32),
            "FICUS_INTERNAL_EVENT_TOKEN": secrets.token_hex(32),
            "SHELL": "/bin/bash",
            "PATH": ROOT + "/bin:" + task_path,
            "DATABASE_URL": f"postgres://postgres:{secrets.token_hex(24)}@{self.database_host}:5432/ficus_harbor",
        }
        await environment.download_file(
            RUNTIME + "/evals/harbor/revision.json",
            self.logs_dir / "runtime-revision.json",
        )

    def observe_progress(self):
        # Record state transitions without task content or extra runtime calls.
        # This measures observed interruptions, not human time saved.
        state = {
            "agents": sorted(
                (a["id"], a["agentTypeId"], a["status"], bool(a.get("questionData")))
                for a in self.snapshot["agents"]
            ),
            "streams": sorted((s["id"], s["status"]) for s in self.snapshot["streams"]),
            "pending_messages": len(self.snapshot.get("pendingMessages", [])),
            "active_executions": sum(
                e["status"] in ACTIVE for e in self.snapshot["executions"]
            ),
        }
        if state != self.last_observation:
            with (self.logs_dir / "progress.jsonl").open("a") as output:
                output.write(json.dumps({"unix_seconds": time.time(), **state}) + "\n")
            self.last_observation = state

    async def bootstrap_command(self, environment, mode, filename):
        return await self.checked(
            environment,
            f"{ROOT}/bin/bun run --preload=./apps/core/src/scripts/harbor-provider.ts apps/core/src/scripts/harbor-trial.ts {mode} {ROOT}/{filename}",
            cwd=RUNTIME,
            env=self.env,
            timeout_sec=60,
        )

    async def ready(self, environment, port):
        for _ in range(120):
            result = await environment.exec(
                f"curl --connect-timeout 1 --max-time 2 -fsS http://127.0.0.1:{port}/ready",
                timeout_sec=15,
            )
            if result.return_code == 0:
                return
            await asyncio.sleep(1)
        raise RuntimeError("Ficus did not become ready; see API/worker logs")

    async def start_process(self, environment, entry, name):
        await self.checked(
            environment,
            f"nohup setsid {ROOT}/bin/bun run --preload=./apps/core/src/scripts/harbor-provider.ts {shlex.quote(entry)} > {ROOT}/{name}.log 2>&1 < /dev/null & echo $! > {ROOT}/{name}.pid",
            cwd=RUNTIME,
            env=self.env,
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ):
        access = self.model_connection
        if not self.model_name or not access.api_key or not access.base_url:
            raise ValueError(
                "An explicit model, API credential and endpoint are required"
            )
        if access.provider != "openai":
            raise ValueError("The pilot supports OpenAI only")
        from urllib.parse import urlsplit

        self.env["FICUS_HARBOR_MODEL_API"] = self.model_api
        self.env["FICUS_HARBOR_BASE_URL"] = access.base_url.rstrip("/")
        password = urlsplit(self.env["DATABASE_URL"]).password
        outcome = "interrupted"
        try:
            if self.database_network == "private":
                await docker("network", "create", "--internal", self.network)
                await docker("network", "connect", self.network, self.container)
            # Ephemeral DB, no published ports, no host data mounts or Docker socket in the task.
            await docker(
                "run",
                "-d",
                "--name",
                self.database,
                *self.database_network_args(),
                "--label",
                "ficus.harbor=true",
                "--tmpfs",
                "/var/lib/postgresql/data",
                "-e",
                f"POSTGRES_PASSWORD={password}",
                "-e",
                "POSTGRES_DB=ficus_harbor",
                "pgvector/pgvector:pg17",
            )
            for attempt in range(60):
                try:
                    await docker(
                        "exec",
                        self.database,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-U",
                        "postgres",
                        "-d",
                        "ficus_harbor",
                    )
                    break
                except RuntimeError:
                    if attempt == 59:
                        raise
                    await asyncio.sleep(1)
            await self.start_process(environment, "apps/core/src/index.ts", "api")
            await self.ready(environment, 17300)
            await self.upload_json(
                environment,
                ROOT + "/trial.json",
                {
                    "model": self.model_name.split("/", 1)[1],
                    "modelApi": self.model_api,
                    "baseUrl": access.base_url,
                    "key": access.api_key,
                    "workspace": self.workspace,
                    "instruction": squad_handoff(instruction, self.workflow),
                    "workflow": self.workflow,
                },
            )
            await self.bootstrap_command(environment, "seed", "identity.json")
            await self.checked(environment, f"rm {ROOT}/trial.json")
            await self.start_process(environment, "apps/core/src/worker.ts", "worker")
            await self.ready(environment, 17302)
            settled_since = None
            while True:
                await self.bootstrap_command(environment, "snapshot", "snapshot.json")
                await environment.download_file(
                    ROOT + "/snapshot.json", self.logs_dir / "snapshot.json"
                )
                self.snapshot = json.loads(
                    (self.logs_dir / "snapshot.json").read_text()
                )
                self.observe_progress()
                status = disposition(self.snapshot)
                # Observe stable quiescence across polls, allowing completion events to enqueue the manager.
                settled_since = (settled_since or time.monotonic()) if status else None
                if settled_since and time.monotonic() - settled_since >= 5:
                    outcome = status
                    break
                await asyncio.sleep(2)
        finally:
            context.metadata = {
                "configuration": self.workflow,
                "model_api": self.model_api,
                "thinking": "medium" if self.model_api == "openai-responses" else "off",
                "outcome": outcome,
                "memory": "fresh-disabled",
                "runtime_sha256": self.version(),
                "database_network": self.database_network,
            }
            # Always stop the owned worker before the benchmark verifier examines the filesystem.
            for name in ("worker", "api"):
                try:
                    await self.checked(
                        environment,
                        f"if test -f {ROOT}/{name}.pid; then "
                        f"pid=$(cat {ROOT}/{name}.pid); kill -TERM -- -$pid 2>/dev/null || true; "
                        "for i in $(seq 1 10); do kill -0 -- -$pid 2>/dev/null || exit 0; sleep 1; done; "
                        "kill -KILL -- -$pid 2>/dev/null || true; fi",
                        timeout_sec=20,
                    )
                except (RuntimeError, OSError, TimeoutError) as error:
                    self.logger.warning("Could not stop owned process: %s", error)
            try:
                await self.bootstrap_command(environment, "snapshot", "snapshot.json")
                await self.bootstrap_command(environment, "export", "messages.json")
            except (RuntimeError, OSError, TimeoutError) as error:
                self.logger.warning("Could not export final Ficus state: %s", error)
            for filename in (
                "api.log",
                "worker.log",
                "identity.json",
                "snapshot.json",
                "messages.json",
            ):
                try:
                    await environment.download_file(
                        ROOT + "/" + filename, self.logs_dir / filename
                    )
                except (RuntimeError, OSError, TimeoutError) as error:
                    self.logger.warning("Could not collect %s: %s", filename, error)
            await docker("rm", "-f", "-v", self.database, check=False)
            if self.database_network == "private":
                await docker(
                    "network", "disconnect", self.network, self.container, check=False
                )
                await docker("network", "rm", self.network, check=False)
            self.populate_context_post_run(context)

    def populate_context_post_run(self, context):
        path = self.logs_dir / "snapshot.json"
        if not path.exists():
            return
        snapshot = json.loads(path.read_text())
        completed_agents = {
            turn["agentId"]
            for turn in snapshot["executions"]
            if turn["status"] == "completed"
        }
        attempted_agents = {turn["agentId"] for turn in snapshot["executions"]}
        attempted_roles = sorted(
            {
                agent["agentTypeId"]
                for agent in snapshot["agents"]
                if agent["id"] in attempted_agents
            }
        )
        context.metadata = {
            **(context.metadata or {}),
            "attempted_roles": attempted_roles,
            "engineer_only_verified": attempted_roles == ["engineer"]
            if getattr(self, "workflow", None) == "engineer"
            else None,
            "executed_roles": sorted(
                {
                    agent["agentTypeId"]
                    for agent in snapshot["agents"]
                    if agent["id"] in completed_agents
                }
            ),
        }
        usage = snapshot["usage"]
        context.n_input_tokens = sum(
            row["inputTokens"] + row["cacheReadTokens"] + row["cacheWriteTokens"]
            for row in usage
        )
        context.n_cache_tokens = sum(row["cacheReadTokens"] for row in usage)
        context.n_output_tokens = sum(row["outputTokens"] for row in usage)
        # Compatible endpoints have no Ficus list price. Never report that as a free trial.
        context.cost_usd = None
