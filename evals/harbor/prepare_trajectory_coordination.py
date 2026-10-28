"""Prepare the preselected trajectory task and isolate log-only fixture changes."""

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
        if isinstance(n, ast.FunctionDef) and n.name == "api_server"
    ]
    lines = source.splitlines(True)
    body = "".join(lines[node.body[0].lineno - 1 : node.end_lineno])
    assert body.count("subprocess.PIPE") == 2
    replacement = body.replace(
        "stdout=subprocess.PIPE",
        'stdout=logs.enter_context(tempfile.NamedTemporaryFile(prefix="server-stdout-", dir="/logs/verifier", delete=False))',
    ).replace(
        "stderr=subprocess.PIPE",
        'stderr=logs.enter_context(tempfile.NamedTemporaryFile(prefix="server-stderr-", dir="/logs/verifier", delete=False))',
    )
    replacement = "    with contextlib.ExitStack() as logs:\n" + "".join(
        "    " + line if line.strip() else line for line in replacement.splitlines(True)
    )
    updated = (
        "".join(lines[: node.body[0].lineno - 1])
        + replacement
        + "".join(lines[node.end_lineno :])
    )
    updated = updated.replace(
        "import subprocess\n",
        "import subprocess\nimport contextlib\nimport tempfile\n",
        1,
    )

    # All assertion/test ASTs remain identical; only the server fixture changes.
    def rest(text):
        t = ast.parse(text)
        t.body = [
            n
            for n in t.body
            if not (isinstance(n, ast.FunctionDef) and n.name == "api_server")
            and not (
                isinstance(n, ast.Import)
                and n.names[0].name in {"contextlib", "tempfile"}
            )
        ]
        return ast.dump(t, include_attributes=False)

    assert rest(source) == rest(updated)
    return updated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory
    source = root / "source/trajectory_api"
    task = root / "task"
    shutil.copytree(HERE / "product-coordination-task", task)
    official = task / "tests/official"
    official.mkdir()
    for name in [
        "conftest.py",
        "test_checkpoint_1.py",
        "test_checkpoint_2.py",
        "test_checkpoint_3.py",
    ]:
        shutil.copyfile(source / "tests" / name, official / name)
    shutil.copytree(source / "tests/data", official / "data")
    if (source / "tests/assets").exists():
        shutil.copytree(source / "tests/assets", official / "assets")
    changes = []
    for name in ["conftest.py", "test_checkpoint_2.py", "test_checkpoint_3.py"]:
        p = official / name
        old = p.read_text()
        new = drain_fixture(old)
        p.write_text(new)
        changes.append(
            {
                "path": "tests/official/" + name,
                "before_sha256": hashlib.sha256(old.encode()).hexdigest(),
                "after_sha256": hashlib.sha256(new.encode()).hexdigest(),
                "diff": "".join(
                    difflib.unified_diff(
                        old.splitlines(True),
                        new.splitlines(True),
                        fromfile="original/" + name,
                        tofile="drained/" + name,
                    )
                ),
            }
        )
    (root / "fixture-amendment.json").write_text(
        json.dumps(
            {
                "scope": "Log capture only; all non-fixture ASTs unchanged. Startup/request/shutdown timeouts retained. No test assertions changed.",
                "changes": changes,
            },
            indent=2,
        )
        + "\n"
    )
    shutil.copytree(source / "solutions/checkpoint_3", task / "solution/reference")
    (task / "solution/solve.sh").write_text(
        "#!/bin/bash\nset -eu\nprintf '#!/usr/bin/env python3\\n' > /app/trajectory_api\ncat /solution/reference/trajectory_api.py >> /app/trajectory_api\nchmod +x /app/trajectory_api\ncd /app\ngit add trajectory_api\ngit commit -m 'Reference implementation'\n"
    )
    p = task / "tests/test.sh"
    p.write_text(
        p.read_text()
        .replace(
            "/tests/official/test_checkpoint_3.py",
            "/tests/official/test_checkpoint_1.py /tests/official/test_checkpoint_2.py /tests/official/test_checkpoint_3.py",
        )
        .replace("/app/config_server", "/app/trajectory_api")
    )
    p = task / "task.toml"
    p.write_text(
        p.read_text().replace(
            "coordination-v4-config-service", "coordination-v5-trajectory-api"
        )
    )
    text = "Build and deliver one integrated trajectory-management API in /app from these three related requests. The repository starts empty. All requests are available now; choose a dependency-aware work breakdown and coordinate the work as a team. Later requirements extend or explicitly supersede earlier ones. Use Python 3.12. Common web, schema, YAML and JSON-patch libraries are installed; /opt/eval-dependencies.txt lists exact versions. You may use these libraries. No network downloads are available during execution. The executable is /app/trajectory_api, with a Python shebang and executable permission. Commit the completed integration tree. Do not seek out benchmark tests or reference solutions.\n\n"
    for i in [1, 2, 3]:
        spec = (
            (source / f"checkpoint_{i}.md")
            .read_text()
            .replace("%%%ENTRYPOINT:entry_file%%%", "trajectory_api")
            .replace("%%%ENTRYPOINT:entry_command%%%", "./trajectory_api")
        )
        text += f"## Request {i}\n\n{spec}\n\n"
    (task / "instruction.md").write_text(text)
    for name in ["tests/test.sh", "solution/solve.sh"]:
        (task / name).chmod(0o755)
    (root / "runtime.tar.gz").symlink_to(root.parent / "coordination-v4/runtime.tar.gz")


if __name__ == "__main__":
    main()
