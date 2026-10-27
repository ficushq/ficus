"""Apply only the original-request preservation guidance delta to the original runtime, without inference."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

PREFIX = "ficus-harbor/runtime/"
PATHS = [
    "config/agent-types/manager.yaml",
    "config/agent-types/reviewer.yaml",
    "config/agent-types/shared/squad-rules.md",
]
BASELINE_SHA = "68c8a5e3263b54639562f259aaa149ae18c61770442a85b4da1d599fb2476ba0"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fingerprint(member, content):
    return (
        member.type.decode(),
        member.mode,
        member.linkname,
        hashlib.sha256(content).hexdigest() if content is not None else None,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("record", type=Path)
    args = parser.parse_args()
    assert not args.output.exists(), "Never overwrite a prepared runtime"
    assert not args.record.exists(), "Never overwrite provenance"
    assert digest(args.baseline) == BASELINE_SHA
    patch = Path(__file__).with_name("requirement-fidelity-guidance.patch").read_bytes()
    before = {}
    replacements = {}
    with tempfile.TemporaryDirectory(prefix="ficus-request-prompts-") as tmp:
        with tarfile.open(args.baseline) as source:
            for member in source:
                content = source.extractfile(member).read() if member.isfile() else None
                assert member.name not in before, "Duplicate archive member"
                before[member.name] = fingerprint(member, content)
                if member.name in {PREFIX + path for path in PATHS}:
                    path = Path(tmp) / member.name.removeprefix(PREFIX)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
        subprocess.run(
            ["git", "apply", "--check", "-"], cwd=tmp, input=patch, check=True
        )
        subprocess.run(["git", "apply", "-"], cwd=tmp, input=patch, check=True)
        replacements = {
            PREFIX + path: (Path(tmp) / path).read_bytes() for path in PATHS
        }

    with (
        tarfile.open(args.baseline) as source,
        tarfile.open(args.output, "w:gz", compresslevel=1) as target,
    ):
        for member in source:
            content = source.extractfile(member).read() if member.isfile() else None
            content = replacements.get(member.name, content)
            if content is not None:
                member.size = len(content)
            target.addfile(member, io.BytesIO(content) if content is not None else None)

    # Independently read every member, including symlink destinations and modes.
    after = {}
    with tarfile.open(args.output) as archive:
        for member in archive:
            assert member.name not in after
            content = archive.extractfile(member).read() if member.isfile() else None
            after[member.name] = fingerprint(member, content)
    assert before.keys() == after.keys()
    changed = sorted(name for name in before if before[name] != after[name])
    assert changed == sorted(replacements)
    args.record.write_text(
        json.dumps(
            {
                "baseline_archive_sha256": BASELINE_SHA,
                "candidate_archive_sha256": digest(args.output),
                "guidance_patch_sha256": hashlib.sha256(patch).hexdigest(),
                "guidance_commit": "79ec0616",
                "member_count": len(before),
                "only_changed_members": changed,
                "members": {
                    path: {"before": before[path][-1], "after": after[path][-1]}
                    for path in changed
                },
                "inference_started": False,
            },
            indent=2,
        )
        + "\n"
    )
    args.output.chmod(0o400)
    print(args.record.read_text())


if __name__ == "__main__":
    main()
