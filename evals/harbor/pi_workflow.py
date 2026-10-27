"""Harbor Pi with its packaged subagent example, not a new orchestration engine."""

import json
from typing import Literal

from harbor.agents.installed.pi import Pi, PiOptions

ROLE_PROMPTS = {
    "architect": "Design a solution that satisfies the request and document implementation guidance. Return requirements, tradeoffs, and a validation plan. Do not implement the solution.",
    "engineer": "Implement the design and run the required validation in the task workspace. Return implementation and validation evidence.",
    "reviewer": "Review the implementation independently against the requirements and design. Run validation as appropriate. Approve it explicitly or request specific implementation changes or a redesign. Do not implement fixes yourself.",
}


def planned_handoff(instruction):
    return (
        "Complete this task through architect, engineer, and independent reviewer subagents. "
        "You are their coordinator, not the implementer. Use the subagent tool; do not solve "
        "the task yourself. Give each role the original task and the relevant prior output. "
        "Have the architect plan, the engineer implement, and the reviewer validate. "
        "Route requested revisions to the engineer (or architect for redesign), then back "
        "to independent review. Finish only after reviewer approval. No human is available. "
        "Leave final files in the supplied disposable task workspace, without GitHub or a PR.\n\n"
        "BEGIN TASK\n" + instruction + "\nEND TASK"
    )


class PiWorkflowOptions(PiOptions):
    workflow: Literal["engineer", "planned"] = "engineer"


class PiWorkflow(Pi):
    options_model = PiWorkflowOptions

    def __init__(self, *args, workflow="engineer", **kwargs):
        if workflow not in {"engineer", "planned"}:
            raise ValueError("Pi supports engineer or planned configurations")
        self.workflow = workflow
        super().__init__(*args, workflow=workflow, **kwargs)

    @staticmethod
    def name():
        return "pi-workflow"

    def _build_custom_models_json(self, access, model_id):
        config = super()._build_custom_models_json(access, model_id)
        if config and model_id == "gpt-6.1-sol":
            model = config["providers"]["harbor-endpoint"]["models"][0]
            model.update(contextWindow=1_050_000, maxTokens=8192)
        return config

    async def install(self, environment):
        await super().install(environment)
        if self.workflow != "planned":
            return
        # Resolve only the Pi installation inside this disposable task container.
        # The extension is outside auto-discovery, so children do not load it.
        source = await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; set -eu; "
                'pi_entry=$(readlink -f "$(command -v pi)"); '
                'pi_package=$(dirname "$(dirname "$(dirname "$pi_entry")")"); '
                'test -f "$pi_package/examples/extensions/subagent/index.ts"; '
                'ln -s "$pi_package/examples/extensions/subagent" /tmp/harbor-pi-subagent; '
                "mkdir -p /tmp/harbor-pi-agent/agents; "
                "sha256sum /tmp/harbor-pi-subagent/index.ts /tmp/harbor-pi-subagent/agents.ts"
            ),
        )
        (self.logs_dir / "subagent-source.sha256").write_text(source.stdout or "")
        for role, instructions in ROLE_PROMPTS.items():
            # No model override: use the dispatching session's exact model/effort.
            text = (
                f"---\nname: {role}\ndescription: {role} stage of the planned workflow\n"
                "tools: read, bash, edit, write, grep, find, ls\n---\n\n"
                + instructions
                + "\nWork directly; do not delegate to other agents.\n"
            )
            await self._upload_config_text(
                environment,
                content=text,
                remote_path=f"/tmp/harbor-pi-agent/agents/{role}.md",
                filename=f"{role}.md",
            )

    def build_cli_flags(self):
        flags = super().build_cli_flags()
        if self.workflow == "planned":
            flags += " --extension /tmp/harbor-pi-subagent/index.ts"
        return flags

    async def run(self, instruction, environment, context):
        await super().run(
            planned_handoff(instruction) if self.workflow == "planned" else instruction,
            environment,
            context,
        )

    def populate_context_post_run(self, context):
        super().populate_context_post_run(context)
        context.metadata = {
            **(context.metadata or {}),
            "configuration": self.workflow,
            "baseline": "Pi packaged subagent example"
            if self.workflow == "planned"
            else "Pi single session",
        }
        # Parent trajectory metrics omit child process inference. Never present
        # them as aggregate usage; the shared proxy ledger is authoritative.
        context.cost_usd = None
        if self.workflow == "planned":
            # Harbor otherwise backfills parent-only model_usage from this ATIF.
            (self.logs_dir / self._TRAJECTORY_FILENAME).unlink(missing_ok=True)
            context.n_input_tokens = None
            context.n_output_tokens = None
            context.n_cache_tokens = None
            roles = set()
            for path in (self.logs_dir / self._SESSIONS_DIRECTORY).glob("*.jsonl"):
                for line in path.read_text().splitlines():
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    message = entry.get("message", {})
                    if (
                        message.get("role") != "toolResult"
                        or message.get("toolName") != "subagent"
                    ):
                        continue
                    for result in (message.get("details") or {}).get("results", []):
                        if (
                            result.get("exitCode") == 0
                            and (result.get("usage") or {}).get("turns", 0) > 0
                        ):
                            roles.add(result.get("agent"))
            context.metadata = {
                **(context.metadata or {}),
                "executed_roles": sorted(roles),
                "required_roles_executed": set(ROLE_PROMPTS).issubset(roles),
            }
