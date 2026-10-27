"""Run one official task with scoped proxy credentials; never forward host API keys."""

import argparse
import json
import os
import tomllib
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("harness", choices=("ficus", "pi"))
parser.add_argument("task", type=Path)
parser.add_argument(
    "--workflow",
    choices=("engineer", "reviewer", "planned", "reviewed"),
    default="engineer",
)
parser.add_argument("--access", type=Path, required=True)
parser.add_argument("--client", help="Proxy client label; defaults to harness-task")
parser.add_argument("--runtime-archive", type=Path)
parser.add_argument("--checkpoint-dir", type=Path)
parser.add_argument("--coordination", action="store_true")
parser.add_argument("--coordination-egress-header-timeout", type=int, choices=(600,))
parser.add_argument("--artifact-patch", type=Path)
parser.add_argument("--artifact-sha256")
parser.add_argument("--base-commit")
parser.add_argument("--jobs-dir", type=Path, required=True)
parser.add_argument("--job-name", required=True)
parser.add_argument(
    "--restricted-network",
    action="store_true",
    help="Keep task network restrictions; allow only the local inference proxy host and use a loopback Ficus DB",
)
args = parser.parse_args()
if args.coordination and args.workflow != "planned":
    parser.error("Coordination requires planned workflow")
if args.coordination_egress_header_timeout and not (
    args.coordination and args.restricted_network
):
    parser.error("Egress timeout override requires restricted coordination mode")
access = json.loads(args.access.read_text())
if args.restricted_network:
    config = tomllib.loads((args.task / "task.toml").read_text())
    if config.get("agent", {}).get("network_mode") != "no-network":
        parser.error("Restricted mode requires an explicit no-network agent policy")
    if config.get("verifier", {}).get("environment_mode") != "separate":
        parser.error("Restricted mode requires a separate pristine verifier")
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
        "OPENAI_API_KEY": access["clients"][
            args.client or f"{args.harness}-{args.task.name}"
        ],
        "OPENAI_BASE_URL": f"http://host.docker.internal:{access['port']}/v1",
        "PYTHONPATH": str(Path(__file__).resolve().parent),
    }
)
if not args.restricted_network:
    env["DOCKER_DEFAULT_PLATFORM"] = "linux/amd64"
# Restricted tasks use each image's architecture: task amd64, native egress
# sidecar. Globally forcing amd64 breaks Harbor's native sidecar on Apple Silicon.
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
if args.restricted_network:
    command += ["--allow-agent-host", "host.docker.internal"]
if args.harness == "ficus":
    if args.runtime_archive is None:
        parser.error("Ficus requires --runtime-archive")
    command += [
        "-a",
        "coordination:FicusCoordination"
        if args.coordination
        else "artifact_reviewer:FicusArtifactReviewer"
        if args.workflow == "reviewer"
        else "ficus_agent:FicusSquad",
        "--ak",
        f"runtime_archive={args.runtime_archive.resolve()}",
        "--ak",
        f"workflow={args.workflow}",
        "--ak",
        "model_api=" + access.get("model_api", "openai-completions"),
    ]
    if args.checkpoint_dir:
        command += ["--ak", f"checkpoint_dir={args.checkpoint_dir.resolve()}"]
    if args.workflow == "reviewer":
        if not all((args.artifact_patch, args.artifact_sha256, args.base_commit)):
            parser.error("Reviewer requires a frozen patch, SHA256, and base commit")
        command += [
            "--disable-verification",
            "--ak",
            f"artifact_patch={args.artifact_patch.resolve()}",
            "--ak",
            f"artifact_sha256={args.artifact_sha256}",
            "--ak",
            f"base_commit={args.base_commit}",
        ]
    if args.restricted_network:
        command += ["--ak", "database_network=task"]
else:
    if args.workflow in {"reviewed", "reviewer"}:
        parser.error("Use engineer or planned for the Pi baseline")
    command += [
        "-a",
        "coordination:PiCoordination"
        if args.coordination
        else "pi_workflow:PiWorkflow",
        "--ak",
        f"workflow={args.workflow}",
        "--ak",
        "version=0.99.1",
        "--ak",
        "model_api=" + access.get("model_api", "openai-completions"),
        "--ak",
        "thinking=" + access.get("thinking", "off"),
    ]
if args.coordination_egress_header_timeout:
    command += [
        "--ak",
        f"egress_header_timeout={args.coordination_egress_header_timeout}",
    ]
os.execvpe("harbor", command, env)
