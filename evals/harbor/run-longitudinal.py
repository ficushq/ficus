"""Run one preflighted persistent arm with a scoped proxy credential."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tomllib
from contract_audit import require_ready
from longitudinal import load_requests

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("arm", choices=["ficus", "pi"])
parser.add_argument("directory", type=Path)
parser.add_argument("--ready", type=Path, required=True)
parser.add_argument("--access", type=Path, required=True)
args = parser.parse_args()
r = args.directory.resolve()
ready = json.loads(args.ready.read_text())
if ready.get("all_gates_passed") is not True:
    parser.error("Readiness gates incomplete")


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


for name, digest in ready["prepared_file_sha256"].items():
    if sha(r / "task" / name) != digest:
        parser.error("Task fingerprint changed: " + name)
require_ready(r / "contract-audit.json", r, ready["contract_audit_sha256"])
requests = load_requests(r / "requests.json", ready["requests_sha256"])
if (r / "task/instruction.md").read_text() != requests[0]:
    parser.error("Only the first frozen request may be in the initial task")
config = tomllib.loads((r / "task/task.toml").read_text())
if (
    config["agent"]["network_mode"] != "no-network"
    or config["verifier"]["environment_mode"] != "separate"
):
    parser.error("Candidate/verifier isolation required")
# Access is read only AFTER all frozen-input validation.
access = json.loads(args.access.read_text())
client = "longv1-paid-" + args.arm
if (
    access.get("model") != "gpt-6.1-sol"
    or access.get("model_api") != "openai-responses"
    or access.get("thinking") != "medium"
):
    parser.error("Frozen model configuration changed")
env = {
    key: os.environ[key]
    for key in [
        "PATH",
        "HOME",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "SSL_CERT_FILE",
    ]
    if key in os.environ
}
env.update(
    OPENAI_API_KEY=access["clients"][client],
    OPENAI_BASE_URL=f"http://host.docker.internal:{access['port']}/v1",
    PYTHONPATH=str(Path(__file__).resolve().parent),
)
command = [
    "harbor",
    "run",
    "-p",
    str(r / "task"),
    "-a",
    "longitudinal:FicusLongitudinal"
    if args.arm == "ficus"
    else "longitudinal:PiLongitudinal",
    "-m",
    "openai/gpt-6.1-sol",
    "-n",
    "1",
    "-k",
    "1",
    "--jobs-dir",
    str(r / "jobs"),
    "--job-name",
    client,
    "--allow-agent-host",
    "host.docker.internal",
    "--ak",
    "workflow=planned",
    "--ak",
    "model_api=openai-responses",
    "--ak",
    "egress_header_timeout=600",
    "--ak",
    "requests_manifest=" + str(r / "requests.json"),
    "--ak",
    "requests_sha256=" + ready["requests_sha256"],
]
if args.arm == "ficus":
    command += [
        "--ak",
        "runtime_archive=" + str(r / "runtime.tar.gz"),
        "--ak",
        "database_network=task",
        "--ak",
        "checkpoint_dir=" + str(r / "checkpoints" / client),
    ]
else:
    command += ["--ak", "version=0.99.1", "--ak", "thinking=medium"]
os.execvpe(command[0], command, env)
