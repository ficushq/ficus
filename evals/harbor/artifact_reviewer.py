"""Review a frozen implementation using a native Ficus reviewer, without repairs.

Host-only patch provenance and post-run checks are never included in the prompt.
This is an isolated diagnostic fixture, not a full-squad benchmark condition.
"""

import hashlib
import json
import re
import shlex
from pathlib import Path

from ficus_agent import FicusSquad, ROOT

REPORT = ROOT + "/review-result.json"


def validate_report(report):
    if not isinstance(report, dict) or report.get("verdict") not in {
        "approve",
        "changes-requested",
        "blocked",
    }:
        raise ValueError("Missing or invalid review verdict")
    for key in ("findings", "observations", "limitations"):
        if not isinstance(report.get(key), list):
            raise ValueError(f"Review requires a {key} list")
    for finding in report["findings"]:
        if not isinstance(finding, dict) or any(
            not isinstance(finding.get(key), str) or not finding[key].strip()
            for key in ("title", "requirement", "location", "evidence", "severity")
        ):
            raise ValueError(
                "Each finding requires title, requirement, location, evidence, severity"
            )
    if report["verdict"] == "approve" and report["findings"]:
        raise ValueError("Blocking findings conflict with approval")
    if report["verdict"] == "changes-requested" and not report["findings"]:
        raise ValueError("Changes requested without findings")
    return report


def validate_provenance(metadata, before, after):
    if before != after:
        raise ValueError("Reviewer modified the frozen repository")
    if metadata.get("attempted_roles") != ["reviewer"] or metadata.get(
        "executed_roles"
    ) != ["reviewer"]:
        raise ValueError("Review requires only native reviewer executions")
    if metadata.get("outcome") != "delivered":
        raise ValueError("Reviewer did not finish the report workflow")


def review_instruction(instruction, base, artifact):
    return (
        "Review the implementation already present in this repository against the original request below. "
        f"The request's starting commit is {base}; the implementation commit is {artifact}. "
        "Inspect that diff and independently check requirements and correctness with the available tools. "
        "This is a review-only assignment: do not repair or change tracked files or create source/tests in the repository. "
        "Use /tmp for scratch reproductions, reports, and temporary environments. Do not spawn agents. "
        "Do not wait for an engineer or request human decisions. Your deliverable is a review report, "
        "so complete this Solo work stream once the report is written even if the verdict requests changes. "
        f"Write JSON to {REPORT} with verdict (approve, changes-requested, or blocked), findings, observations, "
        "and limitations. Findings are blocking defects and each must contain string fields title, requirement, "
        "location (path and line), evidence (reproduction or precise code reasoning), and severity. "
        "Keep nonblocking observations and environment limitations separate. Use empty lists when appropriate.\n\n"
        "Original request (verbatim):\n" + instruction
    )


class FicusArtifactReviewer(FicusSquad):
    def __init__(
        self,
        *args,
        artifact_patch=None,
        artifact_sha256=None,
        base_commit=None,
        **kwargs,
    ):
        if not base_commit or not re.fullmatch(r"[0-9a-f]{40}", base_commit):
            raise ValueError("An exact base commit is required")
        if not artifact_patch or not artifact_sha256:
            raise ValueError("Frozen patch path and SHA256 are required")
        self.patch = Path(artifact_patch).resolve(strict=True)
        self.patch_bytes = self.patch.read_bytes()
        self.patch_sha = hashlib.sha256(self.patch_bytes).hexdigest()
        if self.patch_sha != artifact_sha256:
            raise ValueError("Frozen artifact hash mismatch")
        self.base_commit = base_commit
        if kwargs.pop("workflow", "reviewer") != "reviewer":
            raise ValueError("Artifact reviews require reviewer workflow")
        super().__init__(*args, workflow="reviewer", **kwargs)

    @staticmethod
    def name():
        return "ficus-artifact-reviewer"

    async def repository_state(self, environment):
        return await self.checked(
            environment,
            "git rev-parse HEAD && git diff --binary HEAD && git ls-files --others --exclude-standard",
            cwd=self.workspace,
        )

    async def run(self, instruction, environment, context):
        clean = await self.checked(
            environment, "git status --porcelain", cwd=self.workspace
        )
        head = (
            await self.checked(environment, "git rev-parse HEAD", cwd=self.workspace)
        ).strip()
        if clean.strip() or head != self.base_commit:
            raise ValueError("Review task must begin at the clean pinned base")
        # Upload the bytes whose hash was checked, not a potentially replaced host file.
        frozen = self.logs_dir / "frozen-input.patch"
        frozen.write_bytes(self.patch_bytes)
        await environment.upload_file(frozen, ROOT + "/frozen-input.patch")
        await self.checked(
            environment,
            f"git apply --index {shlex.quote(ROOT + '/frozen-input.patch')} && "
            "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z "
            "git -c user.name='Ficus artifact fixture' -c user.email='fixture@invalid' "
            "commit --allow-empty -m 'Frozen implementation for review'",
            cwd=self.workspace,
        )
        before = await self.repository_state(environment)
        artifact = before.splitlines()[0]
        audit = {
            "base_commit": self.base_commit,
            "artifact_sha256": self.patch_sha,
            "artifact_commit": artifact,
            "valid": False,
        }
        try:
            await super().run(
                review_instruction(instruction, self.base_commit, artifact),
                environment,
                context,
            )
            after = await self.repository_state(environment)
            audit["repository_unchanged"] = before == after
            validate_provenance(context.metadata or {}, before, after)
            await environment.download_file(
                REPORT, self.logs_dir / "review-result.json"
            )
            report = validate_report(
                json.loads((self.logs_dir / "review-result.json").read_text())
            )
            audit.update(valid=True, verdict=report["verdict"])
        finally:
            (self.logs_dir / "artifact-review-audit.json").write_text(
                json.dumps(audit, indent=2) + "\n"
            )
            context.metadata = {**(context.metadata or {}), "artifact_review": audit}
