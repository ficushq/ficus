"""Prepare the pinned external case without putting answers in the agent image."""

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

SOURCE = "https://github.com/gabeorlanski/scb-problems"
REVISION = "9cd9ca3a51c3d3e2a99d2488a25baf73a2204451"
HERE = Path(__file__).resolve().parent
PRELUDE = """Build and deliver one integrated code-search product in /app from these three related requests. The repository starts empty. All requests are available now; choose a dependency-aware work breakdown and coordinate the work as a team. Later requirements extend earlier ones. Use Python 3.12 and its standard library; no network or extra dependencies are required. The executable is /app/code_search, with a Python shebang and executable permission. Commit the completed integration tree. Do not seek out benchmark tests or reference solutions.\n\n"""


def selected(path):
    return (
        path in {"LICENSE", "code_search/config.yaml"}
        or path in {f"code_search/checkpoint_{i}.md" for i in (1, 2, 3)}
        or path.startswith("code_search/tests/")
        or path.startswith("code_search/solutions/checkpoint_3/")
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--source-cache",
        type=Path,
        help="Previously pinned source cache; hashes are checked",
    )
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = out / "source"
    if args.source_cache:
        cache = args.source_cache.resolve()
        hashes = json.loads((cache / "source-sha256.json").read_text())
        for name, expected in hashes.items():
            path = cache / "source" / name
            if (
                not selected(name)
                or ".." in Path(name).parts
                or Path(name).is_absolute()
            ):
                raise ValueError("Invalid source path")
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError(f"Source hash mismatch: {name}")
            dest = source / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
    else:
        tree_url = f"https://api.github.com/repos/gabeorlanski/scb-problems/git/trees/{REVISION}?recursive=1"
        with urllib.request.urlopen(tree_url, timeout=30) as response:
            tree = json.load(response)
        if tree["sha"] != REVISION or tree.get("truncated"):
            raise ValueError("Unexpected source tree")
        paths = [
            x["path"]
            for x in tree["tree"]
            if x["type"] == "blob" and selected(x["path"])
        ]

        def download(name):
            url = f"https://raw.githubusercontent.com/gabeorlanski/scb-problems/{REVISION}/{name}"
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
            dest = source / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return name, hashlib.sha256(data).hexdigest()

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            hashes = dict(pool.map(download, paths))
    (out / "source-sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    task = out / "task"
    shutil.copytree(HERE / "coordination-task", task)
    case = source / "code_search"
    for path in (case / "tests").rglob("*"):
        if path.is_file() and path.name not in (
            "test_checkpoint_4.py",
            "test_checkpoint_5.py",
        ):
            dest = task / "tests/official" / path.relative_to(case / "tests")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
    shutil.copytree(case / "solutions/checkpoint_3", task / "solution/reference")
    text = PRELUDE
    for i in (1, 2, 3):
        spec = (case / f"checkpoint_{i}.md").read_text()
        spec = spec.replace("%%%ENTRYPOINT:entry_file%%%", "code_search").replace(
            "%%%ENTRYPOINT:entry_command%%%", "./code_search"
        )
        text += f"## Request {i}\n\n{spec}\n\n"
    (task / "instruction.md").write_text(text)
    for name in ("tests/test.sh", "solution/solve.sh"):
        (task / name).chmod(0o755)
    files = {
        str(p.relative_to(task)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in task.rglob("*")
        if p.is_file()
    }
    (out / "prepared.json").write_text(
        json.dumps(
            {"source": SOURCE, "revision": REVISION, "task_sha256": files}, indent=2
        )
        + "\n"
    )
    print(out)


if __name__ == "__main__":
    main()
