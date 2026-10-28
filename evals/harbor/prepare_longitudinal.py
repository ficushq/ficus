"""Prepare a private, three-increment DataGate task without future-request leakage."""

import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent


def drain_fixture(source):
    tree = ast.parse(source)
    (node,) = [
        n
        for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "_run_service"
    ]
    lines = source.splitlines(True)
    body = "".join(lines[node.body[0].lineno - 1 : node.end_lineno])
    if body.count("subprocess.PIPE") != 2:
        raise ValueError("Unexpected upstream log fixture")
    body = body.replace(
        "stdout=subprocess.PIPE",
        'stdout=logs.enter_context(tempfile.NamedTemporaryFile(prefix="server-stdout-", dir="/logs/verifier", delete=False))',
    ).replace(
        "stderr=subprocess.PIPE",
        'stderr=logs.enter_context(tempfile.NamedTemporaryFile(prefix="server-stderr-", dir="/logs/verifier", delete=False))',
    )
    body = "    with contextlib.ExitStack() as logs:\n" + "".join(
        "    " + line if line.strip() else line for line in body.splitlines(True)
    )
    updated = (
        "".join(lines[: node.body[0].lineno - 1])
        + body
        + "".join(lines[node.end_lineno :])
    )
    updated = updated.replace(
        "import subprocess\n",
        "import subprocess\nimport contextlib\nimport tempfile\n",
        1,
    )

    def unchanged(text):
        t = ast.parse(text)
        t.body = [
            n
            for n in t.body
            if not (isinstance(n, ast.FunctionDef) and n.name == "_run_service")
            and not (
                isinstance(n, ast.Import)
                and n.names[0].name in {"contextlib", "tempfile"}
            )
        ]
        return ast.dump(t, include_attributes=False)

    assert unchanged(source) == unchanged(updated)
    # All constants/timeouts and the fixture's control flow are retained.
    return updated


def prepare(root):
    source = root / "source/datagate"
    task = root / "task"
    shutil.copytree(HERE / "product-coordination-task", task)
    official = task / "tests/official"
    official.mkdir()
    for name in [
        "conftest.py",
        "_helpers.py",
        *[f"test_checkpoint_{i}.py" for i in range(1, 4)],
    ]:
        shutil.copyfile(source / "tests" / name, official / name)
    p = official / "conftest.py"
    old = p.read_text()
    new = drain_fixture(old)
    p.write_text(new)
    (root / "fixture-amendment.json").write_text(
        json.dumps(
            {
                "scope": "File-backed server stdout/stderr only. No assertion, readiness, request or shutdown timeout changes. Startup failure output lives in named verifier log files.",
                "before_sha256": hashlib.sha256(old.encode()).hexdigest(),
                "after_sha256": hashlib.sha256(new.encode()).hexdigest(),
                "diff": "".join(
                    difflib.unified_diff(
                        old.splitlines(True),
                        new.splitlines(True),
                        fromfile="upstream/conftest.py",
                        tofile="drained/conftest.py",
                    )
                ),
            },
            indent=2,
        )
        + "\n"
    )
    intro = "Build and deliver this product increment in /app. Use Python 3.12; installed libraries are listed in /opt/eval-dependencies.txt. No network downloads are available. The executable is /app/datagate, with a Python shebang and executable permission. Commit the complete integrated product. Preserve earlier delivered behavior unless this request explicitly supersedes it. Do not seek benchmark tests or reference solutions.\n\n"
    requests = [
        intro
        + (source / f"checkpoint_{i}.md")
        .read_text()
        .replace("%%%ENTRYPOINT:entry_command%%%", "./datagate")
        .replace("%%%ENTRYPOINT:entry_file%%%", "datagate")
        for i in range(1, 4)
    ]
    (root / "requests.json").write_text(
        json.dumps({"version": 1, "requests": requests}, indent=2) + "\n"
    )
    (task / "instruction.md").write_text(requests[0])
    # References belong only to the oracle/control side of Harbor.
    for i in range(1, 4):
        shutil.copytree(
            source / f"solutions/checkpoint_{i}", task / f"solution/reference-{i}"
        )
    config = (
        (task / "task.toml")
        .read_text()
        .replace(
            'artifacts = ["/logs/artifacts/model.patch"]',
            'artifacts = ["/logs/artifacts"]',
        )
        .replace("coordination-v4-config-service", "longitudinal-v1-datagate")
        .replace(
            "Benchmark-derived shared-repository coordination case study",
            "Three sequential requests with retained native state",
        )
    )
    # Three independent cumulative suites; each retains the established 300s budget.
    config = config.replace("timeout_sec = 300.0", "timeout_sec = 960.0")
    (task / "task.toml").write_text(config)
    (task / "tests/expected-counts.json").write_text(
        json.dumps({"1": 50, "2": 122, "3": 174}) + "\n"
    )
    shutil.copyfile(HERE / "longitudinal_verify.py", task / "tests/verify.py")
    (task / "tests/test.sh").write_text(
        "#!/bin/bash\nset -eu\nmkdir -p /logs/verifier\ncd /tests\npython3 -I /tests/verify.py\n"
    )
    (task / "tests/test.sh").chmod(0o755)
    # Only the no-provider oracle may install these reference trees.
    (task / "solution/solve.sh").write_text("""#!/bin/bash
set -eu
mkdir -p /logs/artifacts
cd /app
for i in 1 2 3; do
  printf '#!/usr/bin/env python3\\n' > datagate
  cat /solution/reference-$i/datagate.py >> datagate
  chmod +x datagate
  git add datagate
  git commit -qm "Reference increment $i"
  git diff --binary baseline HEAD > /logs/artifacts/increment-$i.patch
  git rev-parse HEAD > /logs/artifacts/increment-$i.head
  git bundle create /logs/artifacts/increment-$i.bundle --all
done
""")
    (task / "solution/solve.sh").chmod(0o755)
    (root / "runtime.tar.gz").symlink_to(root.parent / "coordination-v4/runtime.tar.gz")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    prepare(parser.parse_args().directory.resolve())
