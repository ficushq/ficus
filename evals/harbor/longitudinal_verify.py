"""Grade committed incremental snapshots independently, without candidate feedback."""

import hashlib
import json
import os
import signal
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET


def counts(path):
    cases = list(ET.parse(path).getroot().iter("testcase"))
    return {
        "tests": len(cases),
        "passed": sum(
            not any(c.find(n) is not None for n in ["failure", "error", "skipped"])
            for c in cases
        ),
        "failed": sum(c.find("failure") is not None for c in cases),
        "errors": sum(c.find("error") is not None for c in cases),
        "skipped": sum(c.find("skipped") is not None for c in cases),
    }


def main():
    logs = Path("/logs/verifier")
    expected = json.loads(Path("/tests/expected-counts.json").read_text())
    stages = []
    for index in range(1, 4):
        patch = Path(f"/logs/artifacts/increment-{index}.patch")
        record = {
            "increment": index,
            "accepted": False,
            "expected": expected[str(index)],
        }
        stages.append(record)
        if not patch.exists():
            record["error"] = "Missing committed increment snapshot"
            continue
        record["patch_sha256"] = hashlib.sha256(patch.read_bytes()).hexdigest()
        # Recreate the exact /app baseline before each snapshot. Keeping the
        # declared absolute path also supports legitimate absolute-path imports.
        subprocess.run(
            ["git", "-C", "/app", "reset", "--hard", "baseline"],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "-C", "/app", "clean", "-fdx"], check=True, capture_output=True
        )
        applied = subprocess.run(
            ["git", "-C", "/app", "apply", "--binary", str(patch)],
            capture_output=True,
            text=True,
        )
        if applied.returncode:
            record["error"] = "Patch does not apply to baseline"
            (logs / f"increment-{index}-apply.log").write_text(applied.stderr)
            continue
        xml = logs / f"increment-{index}.xml"
        command = [
            "python3",
            "-I",
            "-m",
            "pytest",
            "-q",
            "-p",
            "no:cacheprovider",
            "--confcutdir=/tests",
            *[f"/tests/official/test_checkpoint_{i}.py" for i in range(1, index + 1)],
            "--entrypoint=/app/datagate",
            f"--checkpoint=checkpoint_{index}",
            f"--junitxml={xml}",
        ]
        with (logs / f"increment-{index}.log").open("w") as output:
            try:
                child = subprocess.Popen(
                    command,
                    cwd="/tests",
                    env={**os.environ, "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"},
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                record["exit_code"] = child.wait(timeout=300)
            except subprocess.TimeoutExpired:
                record["error"] = "Checkpoint verifier exceeded unchanged 300s budget"
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        if xml.exists():
            record.update(counts(xml))
        record["accepted"] = (
            record.get("exit_code") == 0
            and record.get("passed") == record["expected"]
            and record.get("tests") == record["expected"]
            and all(record.get(k) == 0 for k in ["failed", "errors", "skipped"])
        )
    result = {"increments": stages, "accepted": all(s["accepted"] for s in stages)}
    (logs / "increment-results.json").write_text(json.dumps(result, indent=2) + "\n")
    (logs / "reward.txt").write_text("1\n" if result["accepted"] else "0\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
