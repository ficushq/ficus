"""Run one official task with scoped proxy credentials; never forward host API keys."""

import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("harness", choices=("ficus", "pi"))
parser.add_argument("task", type=Path)
parser.add_argument(
    "--workflow", choices=("engineer", "planned", "reviewed"), default="engineer"
)
parser.add_argument("--access", type=Path, required=True)
parser.add_argument("--runtime-archive", type=Path)
parser.add_argument("--jobs-dir", type=Path, required=True)
parser.add_argument("--job-name", required=True)
args = parser.parse_args()
access = json.loads(args.access.read_text())
# Start Harbor with a small environment, not unrelated host provider credentials.
env = {
    key: os.environ[key]
    for key in (
        "PATH",
        "HOME",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "SSL_CERT_FILE",
    )
    if key in os.environ
}
env.update(
    {
        "OPENAI_API_KEY": access["clients"][f"{args.harness}-{args.task.name}"],
        "OPENAI_BASE_URL": f"http://host.docker.internal:{access['port']}/v1",
        "PYTHONPATH": str(Path(__file__).resolve().parent),
        "DOCKER_DEFAULT_PLATFORM": "linux/amd64",
    }
)
command = [
    "harbor",
    "run",
    "-p",
    str(args.task.resolve()),
    "-m",
    "openai/" + access.get("model", "gpt-4.1-mini-2025-04-14"),
    "-n",
    "1",
    "-k",
    "1",
    "--jobs-dir",
    str(args.jobs_dir.resolve()),
    "--job-name",
    args.job_name,
]
if args.harness == "ficus":
    if args.runtime_archive is None:
        parser.error("Ficus requires --runtime-archive")
    command += [
        "-a",
        "ficus_agent:FicusSquad",
        "--ak",
        f"runtime_archive={args.runtime_archive.resolve()}",
        "--ak",
        f"workflow={args.workflow}",
        "--ak",
        "model_api=" + access.get("model_api", "openai-completions"),
    ]
else:
    if args.workflow == "reviewed":
        parser.error("Use engineer or planned for the Pi baseline")
    command += [
        "-a",
        "pi_workflow:PiWorkflow",
        "--ak",
        f"workflow={args.workflow}",
        "--ak",
        "version=0.99.1",
        "--ak",
        "model_api=" + access.get("model_api", "openai-completions"),
        "--ak",
        "thinking=" + access.get("thinking", "off"),
    ]
os.execvpe("harbor", command, env)
