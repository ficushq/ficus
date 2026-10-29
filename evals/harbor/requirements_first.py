"""Separate native expectation drafting from access to a delivered implementation.

The first stage receives no product files, plan, tests, patch, or grader feedback.
The second receives its exact unedited JSON as fallible supporting evidence.
"""

import hashlib
import json
import re
from pathlib import Path

from artifact_reviewer import FicusArtifactReviewer, validate_provenance
from ficus_agent import FicusSquad, ROOT
from reviewer_contract import PromptOverlay

EXPECTATIONS = ROOT + "/requirements-expectations.json"


def validate_expectations(value):
    if not isinstance(value, dict):
        raise ValueError("Expected an expectations object")
    checks = value.get("expectations")
    if not isinstance(checks, list) or not checks:
        raise ValueError("Expected a nonempty expectations list")
    for check in checks:
        if not isinstance(check, dict) or any(
            not isinstance(check.get(k), str) or not check[k].strip()
            for k in ("requirement", "example", "expected", "basis")
        ):
            raise ValueError("Expectation requires requirement, example, expected and basis")
        if check["basis"] not in {"explicit", "interpretation"}:
            raise ValueError("Expectation basis must distinguish explicit from interpretation")
    for key in ("ambiguities", "limitations"):
        if not isinstance(value.get(key), list) or any(
            not isinstance(item, str) for item in value[key]
        ):
            raise ValueError(f"Expected a {key} list of strings")
    return value


def expectation_instruction(original):
    return (
        "This is a requirements-analysis assignment before implementation review. "
        "The workspace intentionally contains no product implementation, design or tests. "
        "Do not seek those materials, benchmark artifacts, external references or prior reviews. "
        "Use only the original requests and explicit amendments below to establish expected observable behavior. "
        "Do not implement the product, judge an absent implementation, ask a human, or spawn agents. "
        "Write a compact record covering materially distinct requested behaviors, grouping duplicate rules. "
        "For each expectation, cite the relevant requirement, give a concrete example and its expected "
        "observable result, and distinguish explicit requirements from your interpretations. "
        "Honor later explicit amendments. Record genuine ambiguities without inventing requirements. "
        "Keep interpretations fallible; do not turn an unspecified detail into a definite demand. "
        f"Write JSON to {EXPECTATIONS} with expectations, ambiguities and limitations. "
        "Each expectations item has nonempty string fields requirement (quote or precise reference), "
        "example, expected, and basis (explicit or interpretation). ambiguities and limitations are lists "
        "of strings, empty when appropriate. This JSON is the deliverable. Complete the Solo work stream "
        "once it is written, without waiting for implementation. Keep the repository unchanged; use /tmp "
        "for any scratch files.\n\nOriginal requests and amendments, verbatim:\n" + original
    )


class RequirementsDrafter(PromptOverlay, FicusSquad):
    def __init__(self, *args, base_commit, **kwargs):
        if not re.fullmatch(r"[0-9a-f]{40}", base_commit):
            raise ValueError("Exact empty base commit required")
        self.base_commit = base_commit
        if kwargs.pop("workflow", "reviewer") != "reviewer":
            raise ValueError("Requirements drafting uses native reviewer only")
        super().__init__(*args, workflow="reviewer", **kwargs)

    async def repository_state(self, environment):
        return await self.checked(
            environment,
            "git rev-parse HEAD && git diff --binary HEAD && git ls-files --others --exclude-standard",
            cwd=self.workspace,
        )

    async def run(self, instruction, environment, context):
        before = await self.repository_state(environment)
        tree = await self.checked(environment, "git ls-tree -r HEAD", cwd=self.workspace)
        history = await self.checked(environment, "git rev-list --all", cwd=self.workspace)
        if before.strip() != self.base_commit or tree.strip() or history.strip() != self.base_commit:
            raise ValueError("Requirements stage must start with only the empty base")
        audit = {"empty_base_verified": True, "base_commit": self.base_commit, "valid": False}
        try:
            await super().run(expectation_instruction(instruction), environment, context)
            after = await self.repository_state(environment)
            validate_provenance(context.metadata or {}, before, after)
            output = self.logs_dir / "requirements-expectations.json"
            await environment.download_file(EXPECTATIONS, output)
            validate_expectations(json.loads(output.read_text()))
            audit.update(
                valid=True,
                repository_unchanged=True,
                expectations_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
            )
        finally:
            (self.logs_dir / "requirements-stage-audit.json").write_text(
                json.dumps(audit, indent=2) + "\n"
            )
            context.metadata = {**(context.metadata or {}), "requirements_stage": audit}


class RequirementsFirstReviewer(PromptOverlay, FicusArtifactReviewer):
    def __init__(self, *args, expectations_path, expectations_sha256, **kwargs):
        self.expectations_bytes = Path(expectations_path).read_bytes()
        self.expectations_sha = hashlib.sha256(self.expectations_bytes).hexdigest()
        if self.expectations_sha != expectations_sha256:
            raise ValueError("Unedited expectations hash mismatch")
        validate_expectations(json.loads(self.expectations_bytes))
        super().__init__(*args, **kwargs)

    async def run(self, instruction, environment, context):
        copied = self.logs_dir / "requirements-expectations-input.json"
        copied.write_bytes(self.expectations_bytes)
        await environment.upload_file(copied, EXPECTATIONS)
        procedure = (
            "\n\nReview procedure (does not amend the requirements above): "
            f"Read {EXPECTATIONS} before examining the implementation or its design/tests. "
            "A separate reviewer derived this record from only the requests and amendments, "
            "without access to this implementation. Use it to guide checks against the integrated "
            "implementation, but treat its interpretations as fallible. Original requests and explicit "
            "amendments are authoritative. If an expectation is wrong or ambiguous, explain that "
            "in the report rather than silently adopting the design's interpretation. "
            "Do not edit the expectation record."
        )
        audit = {"input_sha256": self.expectations_sha, "valid": False}
        try:
            await super().run(instruction + procedure, environment, context)
            returned = self.logs_dir / "requirements-expectations-after.json"
            await environment.download_file(EXPECTATIONS, returned)
            if returned.read_bytes() != self.expectations_bytes:
                raise ValueError("Review changed the expectation record")
            audit.update(valid=True, unchanged=True)
        finally:
            (self.logs_dir / "requirements-handoff.json").write_text(
                json.dumps(audit, indent=2) + "\n"
            )
