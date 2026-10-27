"""Host-only no-inference transport checks; see LONG_FEATURES.md."""

import asyncio
import json
import shlex
from urllib.parse import urlsplit
from pi_workflow import PiWorkflow
from ficus_agent import FicusSquad, docker, ROOT


def probe_origin(base_url):
    """Use an OS-assigned probe port supplied through the normal endpoint config."""
    url = urlsplit(base_url or "")
    if (
        url.scheme != "http"
        or url.hostname != "host.docker.internal"
        or url.path.rstrip("/") != "/v1"
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or not url.port
    ):
        raise ValueError("Probe requires http://host.docker.internal:<port>/v1")
    return f"http://host.docker.internal:{url.port}"


class FicusNetworkSmoke(FicusSquad):
    async def run(self, instruction, environment, context):
        # Infrastructure only: never seed work or invoke a model.
        result = {}
        origin = probe_origin(self.model_connection.base_url)
        assert self.model_api == "openai-responses", (
            "Smoke must exercise the frozen native provider"
        )
        self.env["FICUS_HARBOR_MODEL_API"] = self.model_api
        self.env["FICUS_HARBOR_BASE_URL"] = origin + "/v1"
        try:
            password = urlsplit(self.env["DATABASE_URL"]).password
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
            for n in range(60):
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
                    if n == 59:
                        raise
                    await asyncio.sleep(1)
            query = "const db=new Bun.SQL(process.env.DATABASE_URL); console.log(JSON.stringify(await db`select 1 as ok`)); await db.close();"
            sql = await self.checked(
                environment, f"{ROOT}/bin/bun -e {shlex.quote(query)}", env=self.env
            )
            assert '"ok":1' in sql, sql
            result["database_loopback"] = True
            # 403 is expected from an intentionally unauthenticated private probe.
            probe = await environment.exec(
                "curl --noproxy '*' --max-time 8 -sS -o /tmp/probe.txt -w '%{http_code}' "
                + shlex.quote(origin + "/probe")
            )
            assert probe.return_code == 0 and probe.stdout == "403", str(probe)
            result["scoped_proxy_reachable"] = True
            denied = await environment.exec(
                "curl --noproxy '*' --max-time 5 -fsS https://raw.githubusercontent.com/datacurve-ai/deep-swe/main/README.md >/tmp/forbidden.txt"
            )
            assert denied.return_code != 0, (
                "Public reference source unexpectedly accessible"
            )
            result["public_fetch_blocked"] = True
            await self.start_process(environment, "apps/core/src/index.ts", "api")
            await self.ready(environment, 17300)
            result["ficus_api_ready"] = True
            await self.start_process(environment, "apps/core/src/worker.ts", "worker")
            await self.ready(environment, 17302)
            result["ficus_worker_ready"] = True
            result["native_provider_preload"] = True
            context.metadata = result
        finally:
            (self.logs_dir / "network-smoke.json").write_text(
                json.dumps(result, indent=2) + "\n"
            )
            for name in ("worker", "api"):
                await environment.exec(
                    f"if test -f {ROOT}/{name}.pid; then kill -TERM -- -$(cat {ROOT}/{name}.pid); fi"
                )
            await docker("rm", "-f", "-v", self.database, check=False)


class PiNetworkSmoke(PiWorkflow):
    async def run(self, instruction, environment, context):
        result = {}
        origin = probe_origin(self.model_connection.base_url)
        probe = await self.exec_as_agent(
            environment,
            command="curl --noproxy '*' --max-time 8 -sS -o /tmp/probe.txt -w '%{http_code}' "
            + shlex.quote(origin + "/probe"),
        )
        assert probe.return_code == 0 and probe.stdout == "403", str(probe)
        result["scoped_proxy_reachable"] = True
        denied = await environment.exec(
            command="curl --noproxy '*' --max-time 5 -fsS https://raw.githubusercontent.com/datacurve-ai/deep-swe/main/README.md >/tmp/forbidden.txt"
        )
        assert denied.return_code != 0, (
            "Public reference source unexpectedly accessible"
        )
        result["public_fetch_blocked"] = True
        version = await self.exec_as_agent(
            environment,
            command=". ~/.nvm/nvm.sh; pi --version; test -f /tmp/harbor-pi-subagent/index.ts",
        )
        assert version.return_code == 0 and "0.99.1" in version.stdout
        result["pinned_pi_and_subagent_extension"] = True
        (self.logs_dir / "network-smoke.json").write_text(
            json.dumps(result, indent=2) + "\n"
        )
        context.metadata = result
