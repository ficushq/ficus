"""Versioned, symmetric bookkeeping clarification for future coordination runs.

The original coordination adapter and all frozen study inputs remain unchanged.
"""

from coordination import FicusCoordination, PiCoordination, handoff as original_handoff
from deepswe_network_smoke import FicusNetworkSmoke, PiNetworkSmoke
from ficus_agent import FicusSquad
from harbor.agents.installed.pi import Pi

BOOKKEEPING = """Coordinator-owned evidence bookkeeping:
The coordinator owns factual bookkeeping in COORDINATION.md and may update and
commit package status, handoff references, and already-issued review decisions.
Workers provide their evidence to the coordinator; assign other repository files
to implementation packages. This permission excludes product code, tests,
integration, technical design, substantive product documentation, and changing a
review decision. Cite the actual reviewed product revision and evidence. Do not
claim a later bookkeeping commit was reviewed unless it was. Keep final approval
in the native workflow/role record and reference it rather than requiring a
self-referential final commit hash. Verify bookkeeping changes affect only that
record and leave required delivery files committed. Do not reopen approved
implementation solely to copy its completed review status into this record.
Delegate substantive corrections through the required workflow and preserve every
declared review gate. This bookkeeping permission does not authorize merging
unreviewed implementation or bypassing independent validation.
"""


def handoff(instruction, harness):
    original = original_handoff(instruction, harness)
    before, request = original.split("\nBEGIN REQUESTS\n", 1)
    return before + "\n" + BOOKKEEPING + "\nBEGIN REQUESTS\n" + request


class FicusBookkeepingCoordination(FicusCoordination):
    async def run(self, instruction, environment, context):
        self.coordination_instruction = handoff(instruction, "ficus")
        await FicusSquad.run(self, instruction, environment, context)
        context.metadata = {
            **(context.metadata or {}),
            "study": "coordination-bookkeeping-v1",
            "max_agent_executions": 2,
        }


class PiBookkeepingCoordination(PiCoordination):
    async def run(self, instruction, environment, context):
        await Pi.run(self, handoff(instruction, "pi"), environment, context)
        context.metadata = {
            **(context.metadata or {}),
            "study": "coordination-bookkeeping-v1",
        }


class FicusBookkeepingSmoke(FicusBookkeepingCoordination):
    run = FicusNetworkSmoke.run


class PiBookkeepingSmoke(PiBookkeepingCoordination):
    run = PiNetworkSmoke.run
