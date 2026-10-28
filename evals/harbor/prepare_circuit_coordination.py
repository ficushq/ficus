from pathlib import Path
import shutil
import argparse

parser = argparse.ArgumentParser(
    description="Prepare circuit coordination from an already pinned private source tree"
)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
r = args.directory.resolve()
repo = Path(__file__).resolve().parents[2]
s = r / "source/circuit_eval"
t = r / "task"
shutil.copytree(repo / "evals/harbor/product-coordination-task", t)
(t / "tests/official").mkdir()
for n in [
    "conftest.py",
    "helpers.py",
    "novel_circuits.py",
    *[f"test_checkpoint_{i}.py" for i in [1, 2, 3]],
]:
    shutil.copyfile(s / "tests" / n, t / "tests/official" / n)
shutil.copytree(s / "solutions/checkpoint_3", t / "solution/reference")
(t / "solution/solve.sh").write_text(
    "#!/bin/bash\nset -eu\ncp -R /solution/reference/circuit /app/circuit\nprintf '#!/usr/bin/env python3\\n' > /app/circopt\ncat /solution/reference/circopt.py >> /app/circopt\nchmod +x /app/circopt\ncd /app\ngit add circopt circuit\ngit commit -qm 'Reference implementation'\n"
)
p = t / "tests/test.sh"
p.write_text(
    p.read_text()
    .replace(
        "/tests/official/test_checkpoint_3.py",
        " ".join(
            "/tests/official/test_checkpoint_" + str(i) + ".py" for i in [1, 2, 3]
        ),
    )
    .replace("/app/config_server", "/app/circopt")
)
p = t / "task.toml"
p.write_text(
    p.read_text().replace(
        "coordination-v4-config-service", "coordination-v8-circuit-eval"
    )
)
text = "Build and deliver one integrated circuit-validation and evaluation CLI in /app from these three related requests. The repository starts empty. All requests are available now; choose a dependency-aware work breakdown and coordinate the work as a team. Later requirements extend or explicitly supersede earlier ones. Use Python 3.12. Installed libraries are listed in /opt/eval-dependencies.txt. No network downloads are available during execution. The executable is /app/circopt, with a Python shebang and executable permission. Commit the completed integration tree. Do not seek out benchmark tests or reference solutions.\n\n"
for i in [1, 2, 3]:
    text += (
        f"## Request {i}\n\n"
        + (s / f"checkpoint_{i}.md")
        .read_text()
        .replace("%%%ENTRYPOINT:entry_file%%%", "circopt")
        .replace("%%%ENTRYPOINT:entry_command%%%", "./circopt")
        + "\n\n"
    )
(t / "instruction.md").write_text(text)
for n in ["solution/solve.sh", "tests/test.sh"]:
    (t / n).chmod(0o755)
(r / "runtime.tar.gz").symlink_to(r.parent / "coordination-v4/runtime.tar.gz")

(t / "tests/expected-count.txt").write_text("205\n")
