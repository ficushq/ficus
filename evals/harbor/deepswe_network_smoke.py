"""Host-only no-inference transport checks; see LONG_FEATURES.md."""

import asyncio
import json
import shlex
from urllib.parse import urlsplit
from pi_workflow import PiWorkflow
from ficus_agent import FicusSquad, docker, ROOT


class FicusNetworkSmoke(FicusSquad):
    async def run(self, instruction, environment, context):
        # Infrastructure only: never seed work or invoke a model.
        result = {}
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
                "curl --noproxy '*' --max-time 8 -sS -o /tmp/probe.txt -w '%{http_code}' http://host.docker.internal:18765/probe"
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
            context.metadata = result
        finally:
            (self.logs_dir / "network-smoke.json").write_text(
                json.dumps(result, indent=2) + "\n"
            )
            await environment.exec(
                f"if test -f {ROOT}/api.pid; then kill -TERM -- -$(cat {ROOT}/api.pid); fi"
            )
            await docker("rm", "-f", "-v", self.database, check=False)


class PiNetworkSmoke(PiWorkflow):
    async def run(self, instruction, environment, context):
        result = {}
        probe = await self.exec_as_agent(
            environment,
            command="curl --noproxy '*' --max-time 8 -sS -o /tmp/probe.txt -w '%{http_code}' http://host.docker.internal:18765/probe",
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
