"""Copy a frozen product task and replace undrained pipes with retained log files.

No candidate, acceptance assertion, request, timeout or dependency is changed.
"""

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import shutil

ORIGINAL_SHA = "17f078d42da08acaa4280633a7bbe74e843c8481bbdea5b1276fd23261fcf587"


def amend(source: str) -> str:
    assert hashlib.sha256(source.encode()).hexdigest() == ORIGINAL_SHA
    text = source.replace(
        "import time\n",
        "import time\nfrom pathlib import Path\nfrom typing import TextIO\n",
        1,
    )
    text = text.replace(
        "    proc: subprocess.Popen[str], base_url: str, timeout: float = 10.0\n",
        "    proc: subprocess.Popen[str], base_url: str,\n    stdout_log: TextIO, stderr_log: TextIO, timeout: float = 10.0\n",
        1,
    )
    text = text.replace(
        "            stdout, stderr = proc.communicate(timeout=1)\n",
        "            proc.wait(timeout=1)\n            stdout_log.seek(0)\n            stderr_log.seek(0)\n            stdout, stderr = stdout_log.read(), stderr_log.read()\n",
        1,
    )
    start = text.index("    proc = subprocess.Popen(\n", text.index("def server_url("))
    end = text.index('\n\n\n@pytest.fixture(scope="module")\ndef client', start)
    text = (
        text[:start]
        + """    log_dir = Path("/logs/verifier")
    log_dir.mkdir(parents=True, exist_ok=True)
    # File-backed output cannot fill a PIPE and block the candidate server.
    with (
        (log_dir / "server-stdout.log").open("w+") as stdout_log,
        (log_dir / "server-stderr.log").open("w+") as stderr_log,
    ):
        proc = subprocess.Popen(
            cmd,
            stdout=stdout_log,
            stderr=stderr_log,
            text=True,
        )
        base_url = f"http://127.0.0.1:{port}"
        try:
            _wait_for_server(proc, base_url, stdout_log, stderr_log)
            yield base_url
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
"""
        + text[end:]
    )
    assert "subprocess.PIPE" not in text
    compile(text, "amended-conftest.py", "exec")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("record", type=Path)
    args = parser.parse_args()
    assert not args.destination.exists() and not args.record.exists()
    before = {
        str(p.relative_to(args.source)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in args.source.rglob("*")
        if p.is_file()
    }
    shutil.copytree(args.source, args.destination)
    name = "tests/official/conftest.py"
    original = (args.source / name).read_text()
    patched = amend(original)
    (args.destination / name).write_text(patched)
    after = {
        str(p.relative_to(args.destination)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in args.destination.rglob("*")
        if p.is_file()
    }
    assert before.keys() == after.keys()
    assert [n for n in before if before[n] != after[n]] == [name]
    record = {
        "authorized_change": "User approved grader-only log handling amendment; original timeout retained",
        "changed_path": name,
        "before_sha256": before[name],
        "after_sha256": after[name],
        "all_other_task_files_unchanged": True,
        "source_task_sha256": before,
        "amended_task_sha256": after,
        "model_calls": 0,
        "diff": "".join(
            difflib.unified_diff(
                original.splitlines(True),
                patched.splitlines(True),
                fromfile="original/" + name,
                tofile="amended/" + name,
            )
        ),
    }
    args.record.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"changed_path": name, "all_other_task_files_unchanged": True}))


if __name__ == "__main__":
    main()
