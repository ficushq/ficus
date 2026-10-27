"""No-inference integration probe: restore actual seeded Ficus state offline."""

import asyncio
import json
import shlex
from urllib.parse import urlsplit

from checkpoint import OfflineRestore, capture, command
from ficus_agent import FicusSquad, ROOT, RUNTIME, docker


class FicusCheckpointSmoke(FicusSquad):
    async def run(self, instruction, environment, context):
        if self.checkpoint_dir is None:
            raise ValueError("Probe requires a new private checkpoint directory")
        self.env["FICUS_HARBOR_MODEL_API"] = self.model_api
        self.env["FICUS_HARBOR_BASE_URL"] = self.model_connection.base_url
        result = {"inference_calls": 0, "worker_started": False}
        stopped = False
        try:
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
                "POSTGRES_PASSWORD=" + urlsplit(self.env["DATABASE_URL"]).password,
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
                    "model": "gpt-6.1-sol",
                    "modelApi": self.model_api,
                    "baseUrl": self.model_connection.base_url,
                    "key": "offline-fixture-not-a-key",
                    "workspace": self.workspace,
                    "instruction": "Offline checkpoint fixture. No inference.",
                    "workflow": "engineer",
                },
            )
            await self.bootstrap_command(environment, "seed", "identity.json")
            await self.checked(environment, f"rm {ROOT}/trial.json")
            await self.checked(
                environment,
                f"mkdir -p {ROOT}/data/checkpoint-fixture && printf fixture-session > {ROOT}/data/checkpoint-fixture/session.jsonl",
            )
            await self.checked(
                environment, "printf fixture-workspace > .checkpoint-fixture"
            )
            await self.checked(
                environment,
                f"pid=$(cat {ROOT}/api.pid); kill -TERM -- -$pid 2>/dev/null || true; "
                "for i in $(seq 1 10); do kill -0 -- -$pid 2>/dev/null || exit 0; sleep 1; done; "
                "kill -KILL -- -$pid 2>/dev/null || true",
                timeout_sec=20,
            )
            stopped = True
            for mode, filename in (
                ("snapshot", "snapshot.json"),
                ("export", "messages.json"),
            ):
                await self.bootstrap_command(environment, mode, filename)
                await environment.download_file(
                    ROOT + "/" + filename, self.logs_dir / filename
                )
            manifest = await capture(
                self.checkpoint_dir,
                self.container,
                self.database,
                self.env,
                {"runtime_sha256": self.version(), "purpose": "offline-smoke"},
            )
            result["checkpoint_complete"] = manifest["complete"]
            async with OfflineRestore(self.checkpoint_dir) as restored:
                env_args = [
                    part
                    for key, value in restored.env.items()
                    for part in ("-e", f"{key}={value}")
                ]

                async def execute(script):
                    return await command(
                        "docker",
                        "exec",
                        *env_args,
                        "-w",
                        RUNTIME,
                        restored.container,
                        "/bin/sh",
                        "-c",
                        script,
                    )

                for mode, filename in (
                    ("snapshot", "snapshot.json"),
                    ("export", "messages.json"),
                ):
                    await execute(
                        f"{ROOT}/bin/bun run --preload=./apps/core/src/scripts/harbor-provider.ts apps/core/src/scripts/harbor-trial.ts {mode} {ROOT}/restored-{filename}"
                    )
                    actual = json.loads(
                        await execute(f"cat {ROOT}/restored-{filename}")
                    )
                    expected = json.loads((self.logs_dir / filename).read_text())

                    # PG row order is not a contract; IDs and every value are.
                    def normalized(value):
                        if isinstance(value, list):
                            return sorted(
                                (normalized(v) for v in value),
                                key=lambda v: json.dumps(v, sort_keys=True),
                            )
                        if isinstance(value, dict):
                            return {k: normalized(v) for k, v in value.items()}
                        return value

                    assert normalized(actual) == normalized(expected), filename
                    result[mode + "_restored_exactly"] = True
                assert (
                    await execute(f"cat {ROOT}/data/checkpoint-fixture/session.jsonl")
                    == "fixture-session"
                )
                assert (
                    await execute(
                        f"cat {shlex.quote(self.workspace)}/.checkpoint-fixture"
                    )
                    == "fixture-workspace"
                )
                result["session_and_workspace_restored"] = True
                probe = "import {getSecretStore} from './apps/core/src/services/secrets'; import {readAccountStore} from './apps/core/src/services/agent/account-store'; await getSecretStore().initialize(); const a=readAccountStore().accounts.openai?.[0]; if(a?.credential?.key !== 'offline-fixture-not-a-key') throw new Error('Secret did not restore'); console.log('restored'); process.exit(0);"
                assert (
                    await execute(f"{ROOT}/bin/bun -e {shlex.quote(probe)}")
                ).splitlines()[-1] == "restored"
                result["encrypted_provider_state_restored"] = True
                network = json.loads(
                    await command("docker", "inspect", restored.container)
                )[0]["HostConfig"]["NetworkMode"]
                assert network == "none"
                result["restore_network_disabled"] = True
            context.metadata = result
        finally:
            if not stopped:
                await environment.exec(
                    f"if test -f {ROOT}/api.pid; then kill -TERM -- -$(cat {ROOT}/api.pid); fi"
                )
            await docker("rm", "-f", "-v", self.database, check=False)
            (self.logs_dir / "checkpoint-smoke.json").write_text(
                json.dumps(result, indent=2) + "\n"
            )
