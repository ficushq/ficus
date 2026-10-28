"""No-provider probe of persistent Ficus identity, messages and native memory."""

import asyncio
import json
from urllib.parse import urlsplit
from longitudinal import FicusLongitudinal
from longitudinal_bootstrap import render
from coordination import BOOTSTRAP
from ficus_agent import ROOT, RUNTIME, docker
import tempfile
from pathlib import Path


class FicusPersistenceProbe(FicusLongitudinal):
    async def setup(self, environment):
        await super().setup(environment)
        source = render(BOOTSTRAP.read_text())
        source = source.replace(
            "const root = '/opt/ficus-harbor'",
            "import { WriteService, SearchService, IndexingService } from '../services/memory'\nconst root = '/opt/ficus-harbor'",
        )
        source = source.replace(
            "} else if (command === 'snapshot') {",
            """} else if (command === 'probe-save' || command === 'probe-read') {
  const identity = JSON.parse(await readFile(`${root}/identity.json`, 'utf8'))
  const squad = await Squad.mustFind(identity.squadId)
  if (!squad.metadata?.memory?.enabled) throw new Error('Memory is not enabled')
  if (command === 'probe-save') {
    const saved = await WriteService.instance().write(squad.id, '/memory/continuity.md', '# Continuity\\nquartz continuity sentinel for isolated persistence probe.\\n')
    if (!saved.success) throw new Error(JSON.stringify(saved))
    const indexed = await IndexingService.instance().index(squad.id, 'file', '/memory/continuity.md')
    if (!indexed.success) throw new Error(JSON.stringify(indexed))
  }
  const read = await WriteService.instance().read(squad.id, '/memory/continuity.md')
  const found = await SearchService.instance().search(squad.id, 'quartz continuity sentinel', { mode: 'keyword' })
  if (!read.success || !read.content.includes('quartz continuity') || !found.some(r => r.path === '/memory/continuity.md')) throw new Error('Memory continuity failed')
  await writeFile(output, JSON.stringify({ squadId: squad.id, managerId: squad.managerAgentId, memoryEnabled: true, savedAndFound: true }))
} else if (command === 'snapshot') {""",
        )
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / "probe.ts"
            p.write_text(source)
            await environment.upload_file(
                p, RUNTIME + "/apps/core/src/scripts/harbor-trial.ts"
            )

    async def run(self, instruction, environment, context):
        # No worker is ever started; queued messages cannot invoke a model.
        self.env["FICUS_HARBOR_MODEL_API"] = self.model_api
        self.env["FICUS_HARBOR_BASE_URL"] = "http://127.0.0.1:9/v1"
        self.coordination_instruction = (
            "Persistence probe first request, do not execute."
        )
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
                f"POSTGRES_PASSWORD={urlsplit(self.env['DATABASE_URL']).password}",
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
                    "model": "gpt-6.1-sol",
                    "modelApi": "openai-responses",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "key": "NO_PROVIDER_PERSISTENCE_PROBE",
                    "workspace": "/app",
                    "instruction": self.coordination_instruction,
                    "workflow": "planned",
                },
            )
            await self.bootstrap_command(environment, "seed", "identity.json")
            await self.bootstrap_command(environment, "probe-save", "probe-before.json")
            await self.upload_json(
                environment,
                ROOT + "/next-request.json",
                {
                    "round": 2,
                    "instruction": "Persistence probe second request, do not execute.",
                },
            )
            await self.bootstrap_command(environment, "follow-up", "followup.json")
            await self.bootstrap_command(environment, "probe-read", "probe-after.json")
            await self.bootstrap_command(environment, "snapshot", "snapshot.json")
            for name in [
                "identity",
                "probe-before",
                "probe-after",
                "followup",
                "snapshot",
            ]:
                await environment.download_file(
                    ROOT + "/" + name + ".json", self.logs_dir / (name + ".json")
                )
            before = json.loads((self.logs_dir / "probe-before.json").read_text())
            after = json.loads((self.logs_dir / "probe-after.json").read_text())
            snap = json.loads((self.logs_dir / "snapshot.json").read_text())
            assert before == after
            assert (
                len(snap["pendingMessages"]) == 2
                and all(
                    e["status"] == "queued" and e["usage"] is None
                    for e in snap["executions"]
                )
                and not snap["usage"]
            )
            context.metadata = {
                "persistent_identity": True,
                "queued_followup": True,
                "native_memory_write_read_search": True,
                "provider_calls": 0,
            }
            (self.logs_dir / "persistence-probe.json").write_text(
                json.dumps(context.metadata, indent=2) + "\n"
            )
        finally:
            await environment.exec(
                f"if test -f {ROOT}/api.pid; then kill -TERM -- -$(cat {ROOT}/api.pid); fi"
            )
            await docker("rm", "-f", "-v", self.database, check=False)
