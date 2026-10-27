"""Benchmark-derived shared-repository coordination, using the existing harnesses."""

import hashlib
import json
from pathlib import Path
from typing import Literal

from coordination_egress import configure_timeout
from deepswe_network_smoke import FicusNetworkSmoke, PiNetworkSmoke
from ficus_agent import FicusSquad, ROOT, RUNTIME
from pi_workflow import PiWorkflow, PiWorkflowOptions
from harbor.agents.installed.pi import Pi

BOOTSTRAP = (
    Path(__file__).resolve().parents[2] / "apps/core/src/scripts/harbor-trial.ts"
)

CONTRACT = """Coordinate these related requests in one persistent local repository.
You are the coordinator, not the implementer. Delegate technical planning to an
architect, implementation and integration to engineers, and independent validation
to reviewers. Create at least three distinct implementation work packages, plus a
final integration/review package. Choose the boundaries and dependency graph from
the supplied requirements; do not replace them with one monolithic implementation.
Run ready, independent packages concurrently when safe, with at most two workers.
Use local Git branches/worktrees or explicit disjoint file ownership to prevent
concurrent edits from overwriting each other. Record package IDs, dependencies,
owners, branch/path assignments, handoff commits, review decisions, and integration
results in COORDINATION.md. This record is evidence, not a substitute for execution.
Keep all work in this disposable task environment. No remote GitHub, PR, human
approval, or deployment is needed. Route repairs back to engineers and obtain
independent review of the final integrated tree. Leave the final executable and
all required files committed in /app, not only in worker branches. Preserve earlier
requirements except where a later requirement explicitly supersedes them. No human
can provide clarifications; delegate investigation and document reasonable choices.
Preserve the original request text in a durable shared source accessible to every
role. Include its exact path/reference in every work package alongside that
package's assigned scope, dependencies, and acceptance criteria. Summaries and
plans supplement this source; they do not replace it. Every architect, engineer,
and reviewer must read the original requirements relevant to their assignment.
Original requirements take precedence over derived plans. Pass relevant handoff
outputs as well, and validate the integrated product against the original source.
"""


def handoff(instruction, harness):
    mechanics = (
        "Use native Ficus work streams and the saved planning/engineering/review "
        "workflow for each package. Use the CLI to schedule dependencies; consult "
        "its help. Start with the manager creating the work streams.\n"
        if harness == "ficus"
        else "Use the packaged subagent tool with architect, engineer, and reviewer "
        "roles. A work package is a distinct documented subagent assignment. Use "
        "parallel dispatch for ready independent packages; never more than two "
        "concurrent children.\n"
    )
    return CONTRACT + mechanics + "\nBEGIN REQUESTS\n" + instruction + "\nEND REQUESTS"


class FicusCoordination(FicusSquad):
    def __init__(self, *args, workflow="planned", egress_header_timeout=None, **kwargs):
        if workflow != "planned":
            raise ValueError("Coordination requires the planned workflow")
        self.egress_evidence = configure_timeout(egress_header_timeout)
        super().__init__(*args, workflow=workflow, **kwargs)
        if self.egress_evidence is not None:
            (self.logs_dir / "coordination-egress.json").write_text(
                json.dumps(self.egress_evidence, indent=2) + "\n"
            )

    async def setup(self, environment):
        await super().setup(environment)
        # Explicit fixture overlay: production runtime and prompts stay frozen.
        await environment.upload_file(
            BOOTSTRAP, RUNTIME + "/apps/core/src/scripts/harbor-trial.ts"
        )
        (self.logs_dir / "coordination-bootstrap.sha256").write_text(
            hashlib.sha256(BOOTSTRAP.read_bytes()).hexdigest() + "\n"
        )
        self.env["MAX_CONCURRENT_AGENTS"] = "2"

    async def upload_json(self, environment, destination, payload):
        if destination == ROOT + "/trial.json":
            payload = {
                **payload,
                "coordination": True,
                "instruction": self.coordination_instruction,
            }
        await super().upload_json(environment, destination, payload)

    async def run(self, instruction, environment, context):
        self.coordination_instruction = handoff(instruction, "ficus")
        await super().run(instruction, environment, context)
        context.metadata = {
            **(context.metadata or {}),
            "study": "coordination-v1",
            "max_agent_executions": 2,
        }


class PiCoordinationOptions(PiWorkflowOptions):
    egress_header_timeout: Literal[600] | None = None


class PiCoordination(PiWorkflow):
    options_model = PiCoordinationOptions

    def __init__(self, *args, workflow="planned", egress_header_timeout=None, **kwargs):
        if workflow != "planned":
            raise ValueError("Coordination requires the planned workflow")
        self.egress_evidence = configure_timeout(egress_header_timeout)
        super().__init__(*args, workflow=workflow, **kwargs)
        if self.egress_evidence is not None:
            (self.logs_dir / "coordination-egress.json").write_text(
                json.dumps(self.egress_evidence, indent=2) + "\n"
            )

    async def install(self, environment):
        await super().install(environment)
        result = await self.exec_as_agent(
            environment,
            command="""python3 - <<'PATCH'
from pathlib import Path
from typing import Literal
p = Path('/tmp/harbor-pi-subagent/index.ts')
s = p.read_text()
assert s.count('const MAX_CONCURRENCY = 4;') == 1, 'Unexpected packaged extension'
p.write_text(s.replace('const MAX_CONCURRENCY = 4;', 'const MAX_CONCURRENCY = 2;'))
PATCH
sha256sum /tmp/harbor-pi-subagent/index.ts""",
        )
        if result.return_code:
            raise RuntimeError("Unable to enforce Pi two-child concurrency limit")
        (self.logs_dir / "coordination-subagent.sha256").write_text(result.stdout or "")

    async def run(self, instruction, environment, context):
        # Bypass the single-task wrapper, retaining packaged role definitions,
        # extension, model configuration, logs and all-role proxy accounting.
        await Pi.run(self, handoff(instruction, "pi"), environment, context)
        context.metadata = {**(context.metadata or {}), "study": "coordination-v1"}


# These subclasses never seed a task or invoke inference. They exercise the
# coordination-specific setup using the existing transport checks.


class FicusCoordinationSmoke(FicusCoordination):
    run = FicusNetworkSmoke.run


class PiCoordinationSmoke(PiCoordination):
    run = PiNetworkSmoke.run
