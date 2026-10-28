"""Paired native-review diagnostic with a pinned reviewer YAML overlay only.

Task artifacts, model/runtime and review protocol stay identical across prompts.
Host-only case labels and scoring are never injected into the reviewer session.
"""

import hashlib
import json
import shlex
from pathlib import Path

import yaml

from artifact_reviewer import FicusArtifactReviewer
from coordination_egress import configure_timeout
from deepswe_network_smoke import FicusNetworkSmoke
from ficus_agent import ROOT, RUNTIME


def frozen_prompt(path, expected_sha):
    contents = Path(path).read_bytes()
    if hashlib.sha256(contents).hexdigest() != expected_sha:
        raise ValueError("Reviewer prompt hash mismatch")
    parsed = yaml.safe_load(contents)
    if parsed.get("id") != "reviewer" or not parsed.get("systemPrompt"):
        raise ValueError("Expected a reviewer agent type with a system prompt")
    return contents, parsed["systemPrompt"]


class PromptOverlay:
    def __init__(self, *args, reviewer_prompt, reviewer_prompt_sha256, **kwargs):
        self.prompt_bytes, self.prompt_body = frozen_prompt(
            reviewer_prompt, reviewer_prompt_sha256
        )
        self.prompt_sha = reviewer_prompt_sha256
        self.prompt_verified = False
        configure_timeout(600)
        super().__init__(*args, **kwargs)

    async def setup(self, environment):
        await super().setup(environment)
        prompt = self.logs_dir / "reviewer-input.yaml"
        prompt.write_bytes(self.prompt_bytes)
        await environment.upload_file(
            prompt, RUNTIME + "/config/agent-types/reviewer.yaml"
        )

    async def ready(self, environment, port):
        await super().ready(environment, port)
        if port != 17300 or self.prompt_verified:
            return
        query = (
            "const db=new Bun.SQL(process.env.DATABASE_URL); "
            "const rows=await db`select system_prompt from agent_types where id='reviewer'`; "
            "console.log(JSON.stringify(rows)); await db.close();"
        )
        rows = json.loads(
            await self.checked(
                environment, f"{ROOT}/bin/bun -e {shlex.quote(query)}", env=self.env
            )
        )
        actual = rows[0]["system_prompt"] if len(rows) == 1 else ""
        if " ".join(self.prompt_body.split()) not in " ".join(actual.split()):
            raise ValueError("Native synced reviewer prompt does not contain the frozen body")
        self.prompt_verified = True
        (self.logs_dir / "reviewer-prompt-audit.json").write_text(
            json.dumps(
                {
                    "overlay_sha256": self.prompt_sha,
                    "only_overlay_path": "config/agent-types/reviewer.yaml",
                    "native_synced_body_verified": True,
                    "synced_prompt_sha256": hashlib.sha256(actual.encode()).hexdigest(),
                    "egress": configure_timeout(600),
                },
                indent=2,
            ) + "\n"
        )


class ContractReviewer(PromptOverlay, FicusArtifactReviewer):
    pass


class ContractReviewSmoke(PromptOverlay, FicusNetworkSmoke):
    pass
