"""Isolate a local lv1 FeatureBench task without changing its acceptance grader.

Host-only preparation. Answer fixtures live in tests/ and solution/, which Harbor
uploads only for verification/oracle execution, never in the agent image.
"""

import argparse
import hashlib
import json
import shutil
import shlex
import subprocess
import tarfile
import tempfile
import uuid
from pathlib import Path

from verify_featurebench import LAYOUTS

RESTORE = r"""#!/bin/bash
set -euo pipefail
fixtures="$(cd "$(dirname "$0")" && pwd)/fixtures"
# Restore only the upstream Git/index state, never overwrite agent working files.
rm -rf /testbed/.git
tar -xzf "$fixtures/original-git.tar.gz" -C /testbed
cp "$fixtures/setup_patch.diff" /tmp/setup_patch.diff
cp "$fixtures/test_patch.diff" /tmp/test_patch.diff
cp "$fixtures/image_baseline_status.txt" /tmp/image_baseline_status.txt
cp "$fixtures/image_baseline_diff_hash.txt" /tmp/image_baseline_diff_hash.txt
"""

SANITIZE = r"""set -euo pipefail
cd /testbed
test -s /tmp/setup_patch.diff
# Reject an image whose task mask did not apply successfully.
git apply --reverse --check /tmp/setup_patch.diff
rm -rf .git /root/my_repo /root/.cache /tmp/.hb_solution.tar.gz /tmp/.hb_extract
rm -f /tmp/setup_patch.diff /tmp/test_patch.diff /tmp/image_baseline_status.txt /tmp/image_baseline_diff_hash.txt
find /testbed -type d -name __pycache__ -prune -exec rm -rf '{}' +
find /testbed -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
# Patch backup files need explicit inspection, never silently remove project files.
test -z "$(find /testbed -type f \( -name '*.orig' -o -name '*.rej' \) -print -quit)"
git init -q
git config user.email benchmark@localhost
git config user.name Benchmark
git add -A
git commit -qm 'Masked task baseline' --allow-empty
test "$(git rev-list --all --count)" = 1
test -z "$(git status --porcelain)"
"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def call(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def docker(*args, **kwargs):
    return call("docker", *args, **kwargs)


def prepare(task, image, output):
    task = task.resolve(strict=True)
    if not task.name.endswith(".lv1"):
        raise ValueError("Only audited lv1 task preparation is supported")
    prefixes = {
        "pydantic__pydantic.": "pydantic",
        "pandas-dev__pandas.": "pandas",
        "sphinx-doc__sphinx.": "sphinx",
    }
    layout = next((v for k, v in prefixes.items() if task.name.startswith(k)), None)
    if layout is None:
        raise ValueError(
            "Only explicitly audited repository verifier layouts are supported"
        )
    verifier_paths = LAYOUTS[layout]
    if output.exists():
        raise ValueError("Output must be new; do not overwrite a frozen task")
    source_paths = [
        task / "task.toml",
        task / "instruction.md",
        task / "environment/Dockerfile",
        task / "environment/setup_patch.diff",
        task / "environment/test_patch.diff",
        task / "tests/test.sh",
        task / "solution/solve.sh",
    ]
    if not source_paths[3].read_bytes().strip():
        raise ValueError("lv1 requires a nonempty masking patch")
    source_paths.extend(
        p for p in (task / "tests").rglob("*") if p.is_file() and p not in source_paths
    )
    provenance = {str(p.relative_to(task)): digest(p) for p in source_paths}
    container = "ficus-featurebench-prepare-" + uuid.uuid4().hex[:12]
    image_id = docker(
        "image", "inspect", "--format", "{{.Id}}", image, capture_output=True, text=True
    ).stdout.strip()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="featurebench-prepare-", dir=output.parent
    ) as tmp:
        stage = Path(tmp) / "task"
        (stage / "environment").mkdir(parents=True)
        fixtures = stage / "tests/fixtures"
        fixtures.mkdir(parents=True)
        created = False
        try:
            docker(
                "run",
                "-d",
                "--platform",
                "linux/amd64",
                "--name",
                container,
                "--label",
                "ficus.featurebench.prepare=true",
                "--network",
                "none",
                "--entrypoint",
                "/bin/bash",
                image_id,
                "-c",
                "exec sleep infinity",
                stdout=subprocess.DEVNULL,
            )
            created = True
            # All preparation commands operate only on the owned disposable container.
            with (fixtures / "original-git.tar.gz").open("wb") as target:
                docker(
                    "exec",
                    container,
                    "tar",
                    "-czf",
                    "-",
                    "-C",
                    "/testbed",
                    ".git",
                    stdout=target,
                )
            for filename in (
                "setup_patch.diff",
                "test_patch.diff",
                "image_baseline_status.txt",
                "image_baseline_diff_hash.txt",
            ):
                docker("cp", f"{container}:/tmp/{filename}", str(fixtures / filename))
            for filename in ("setup_patch.diff", "test_patch.diff"):
                if digest(fixtures / filename) != digest(
                    task / "environment" / filename
                ):
                    raise ValueError("Image fixture does not match task: " + filename)
            # Immutable acceptance files stay host-side until grading. Include the
            # complete test tree and pytest configuration, not agent-authored tests.
            with (fixtures / "verifier-inputs.tar.gz").open("wb") as target:
                docker(
                    "exec",
                    container,
                    "git",
                    "-C",
                    "/testbed",
                    "archive",
                    "--format=tar.gz",
                    "HEAD",
                    *verifier_paths,
                    stdout=target,
                )
            with tarfile.open(fixtures / "verifier-inputs.tar.gz") as archive:
                expected = {
                    member.name: (
                        "symlink:" + member.linkname
                        if member.issym()
                        else hashlib.sha256(
                            archive.extractfile(member).read()
                        ).hexdigest()
                    )
                    for member in archive.getmembers()
                    if member.isfile() or member.issym()
                }
            (fixtures / "verifier-inputs.json").write_text(
                json.dumps(expected, sort_keys=True)
            )
            (fixtures / "verifier-layout.json").write_text(
                json.dumps({"layout": layout})
            )
            docker("exec", container, "bash", "-c", SANITIZE)
            audit = docker(
                "exec",
                container,
                "bash",
                "-c",
                r"""
set -eu
for p in /root/my_repo /tmp/setup_patch.diff /tmp/test_patch.diff /tmp/.hb_solution.tar.gz /tmp/.hb_extract /tests /solution; do
  test ! -e "$p" || { echo "Unexpected fixture: $p"; exit 1; }
done
cd /testbed
git fsck --no-reflogs --unreachable
printf 'root_commits='; git rev-list --all --count
printf 'working_tree='; git status --porcelain
""",
                capture_output=True,
                text=True,
            ).stdout
            sanitized = docker(
                "commit",
                "--change",
                "WORKDIR /testbed",
                "--change",
                'ENTRYPOINT ["/usr/bin/env"]',
                "--change",
                'CMD ["sleep", "infinity"]',
                container,
                capture_output=True,
                text=True,
            ).stdout.strip()
            tag = "ficus-featurebench-sanitized:" + container.rsplit("-", 1)[-1]
            docker("tag", sanitized, tag)
            (stage / "environment/Dockerfile").write_text(
                f"FROM {tag}\nWORKDIR /testbed\n"
            )
            for filename in ("task.toml", "instruction.md"):
                shutil.copyfile(task / filename, stage / filename)
            task_config = stage / "task.toml"
            task_config.write_text(
                'artifacts = [{ source = "/testbed", destination = "workspace", exclude = [".git", "__pycache__", ".pytest_cache"] }]\n\n'
                + task_config.read_text()
            )
            shutil.copytree(task / "tests", stage / "tests", dirs_exist_ok=True)
            shutil.copyfile(task / "tests/test.sh", stage / "tests/upstream-test.sh")
            (stage / "tests/restore.sh").write_text(RESTORE)
            shutil.copyfile(
                Path(__file__).with_name("verify_featurebench.py"),
                stage / "tests/verify_featurebench.py",
            )
            (stage / "tests/test.sh").write_text(
                "#!/bin/bash\nset -euo pipefail\n"
                "mkdir -p /logs/artifacts /logs/verifier\n"
                "tar -czf /logs/artifacts/submission.tar.gz --exclude=.git --exclude=__pycache__ --exclude=.pytest_cache -C /testbed .\n"
                "sha256sum /logs/artifacts/submission.tar.gz > /logs/artifacts/submission.sha256\n"
                "# A failed preparation/check can never leave a passing reward.\n"
                "trap 'echo 0 > /logs/verifier/reward.txt; echo verifier_input_failure > /logs/verifier/reason.txt' ERR\n"
                "bash /tests/restore.sh\n"
                "python3 /tests/verify_featurebench.py restore\n"
                f"git -C /testbed restore --source=HEAD --staged -- {shlex.join(verifier_paths)}\n"
                "bash /tests/upstream-test.sh\n"
                "python3 /tests/verify_featurebench.py check\n"
            )
            # Oracle fixtures are uploaded only when running Harbor's oracle agent.
            shutil.copytree(stage / "tests", stage / "solution")
            shutil.copyfile(
                task / "solution/solve.sh", stage / "solution/upstream-solve.sh"
            )
            (stage / "solution/solve.sh").write_text(
                "#!/bin/bash\nset -euo pipefail\nbash /solution/restore.sh\nexec bash /solution/upstream-solve.sh\n"
            )
            manifest = {
                "source_task": task.name,
                "verifier_layout": layout,
                "verifier_paths": verifier_paths,
                "source_files_sha256": provenance,
                "original_image_id": image_id,
                "agent_image_id": sanitized,
                "agent_image_tag": tag,
                "preparation_sha256": digest(Path(__file__)),
                "audit": audit,
                "verifier_inputs_sha256": digest(fixtures / "verifier-inputs.tar.gz"),
                "verifier_guard_sha256": digest(stage / "tests/verify_featurebench.py"),
                "grader_unchanged": digest(stage / "tests/upstream-test.sh")
                == provenance["tests/test.sh"],
            }
            (stage / "preparation.json").write_text(
                json.dumps(manifest, indent=2) + "\n"
            )
            stage.rename(output)
            print(json.dumps(manifest, indent=2))
        finally:
            if created:
                docker("rm", "-f", container, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", type=Path)
    parser.add_argument(
        "--image", required=True, help="Locally built upstream task image"
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.task, args.image, args.output)
