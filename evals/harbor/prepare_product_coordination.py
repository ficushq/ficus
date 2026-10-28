"""Prepare the preselected external configuration-service task, without inference."""

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

from prepare_coordination import REVISION, SOURCE

HERE = Path(__file__).resolve().parent
CASE = "dynamic_config_service_api"
PRELUDE = """Build and deliver one integrated configuration-service product in /app from these three related requests. The repository starts empty. All requests are available now; choose a dependency-aware work breakdown and coordinate the work as a team. Later requirements extend or explicitly supersede earlier ones. Use Python 3.12. Common web, schema, YAML and JSON-patch libraries are installed; /opt/eval-dependencies.txt lists exact versions. You may use these libraries rather than reimplementing their functionality. No network downloads are available during execution. The executable is /app/config_server, with a Python shebang and executable permission. Commit the completed integration tree. Do not seek out benchmark tests or reference solutions.\n\n"""


def selected(name):
    return (
        name == "LICENSE"
        or name == f"{CASE}/config.yaml"
        or name in {f"{CASE}/checkpoint_{i}.md" for i in (1, 2, 3)}
        or name
        in {f"{CASE}/tests/{n}" for n in ("conftest.py", "test_checkpoint_3.py")}
        or name.startswith(f"{CASE}/solutions/checkpoint_3/")
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    plan = json.loads((HERE / "coordination-v4-selection.json").read_text())
    assert plan["case"] == CASE and plan["revision"] == REVISION
    with urllib.request.urlopen(
        f"https://api.github.com/repos/gabeorlanski/scb-problems/git/trees/{REVISION}?recursive=1",
        timeout=30,
    ) as response:
        tree = json.load(response)
    assert tree["sha"] == REVISION and not tree.get("truncated")
    (out / "source-tree.json").write_text(json.dumps(tree) + "\n")
    paths = [
        x["path"] for x in tree["tree"] if x["type"] == "blob" and selected(x["path"])
    ]

    def download(name):
        with urllib.request.urlopen(
            f"https://raw.githubusercontent.com/gabeorlanski/scb-problems/{REVISION}/{name}",
            timeout=30,
        ) as response:
            data = response.read()
        path = out / "source" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return name, hashlib.sha256(data).hexdigest()

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        hashes = dict(pool.map(download, paths))
    for name, expected in plan["spec_sha256"].items():
        assert hashes[name] == expected, name
    (out / "source-sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    task = out / "task"
    shutil.copytree(HERE / "product-coordination-task", task)
    source = out / "source" / CASE
    shutil.copytree(source / "tests", task / "tests/official")
    shutil.copytree(source / "solutions/checkpoint_3", task / "solution/reference")
    text = PRELUDE
    for i in (1, 2, 3):
        spec = (source / f"checkpoint_{i}.md").read_text()
        spec = spec.replace("%%%ENTRYPOINT:entry_file%%%", "config_server").replace(
            "%%%ENTRYPOINT:entry_command%%%", "./config_server"
        )
        text += f"## Request {i}\n\n{spec}\n\n"
    (task / "instruction.md").write_text(text)
    for name in ("tests/test.sh", "solution/solve.sh"):
        (task / name).chmod(0o755)
    (out / "prepared.json").write_text(
        json.dumps(
            {
                "source": SOURCE,
                "revision": REVISION,
                "task_sha256": {
                    str(p.relative_to(task)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in task.rglob("*")
                    if p.is_file()
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(out)


if __name__ == "__main__":
    main()
