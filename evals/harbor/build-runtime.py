"""Export tracked source only, then build the Linux runtime archive. No .env or host auth."""

import argparse
import hashlib
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--platform", default="linux/amd64")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="ficus-harbor-build-") as temporary:
        stage = Path(temporary)
        archive = stage / "source.tar"
        subprocess.run(
            ["git", "archive", "--format=tar", f"--output={archive}", "HEAD"],
            cwd=root,
            check=True,
        )
        context = stage / "context"
        context.mkdir()
        with tarfile.open(archive) as source:
            source.extractall(context, filter="data")
        # Include this integration's working copy while developing; never recursively copy the checkout.
        import shutil

        (context / "evals/harbor").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(
            root / "evals/harbor/Dockerfile", context / "evals/harbor/Dockerfile"
        )
        shutil.copyfile(
            root / "apps/core/src/scripts/harbor-trial.ts",
            context / "apps/core/src/scripts/harbor-trial.ts",
        )
        (context / "evals/harbor/revision.json").write_text(
            json.dumps(
                {
                    "ficus_commit": revision,
                    "platform": args.platform,
                    "bootstrap_sha256": hashlib.sha256(
                        (root / "apps/core/src/scripts/harbor-trial.ts").read_bytes()
                    ).hexdigest(),
                }
            )
        )
        image = "ficus-harbor-runtime:" + revision[:12]
        subprocess.run(
            [
                "docker",
                "build",
                "--platform",
                args.platform,
                "-f",
                "evals/harbor/Dockerfile",
                "-t",
                image,
                ".",
            ],
            cwd=context,
            check=True,
        )
        container = subprocess.check_output(
            ["docker", "create", "--platform", args.platform, image], text=True
        ).strip()
        try:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [
                    "docker",
                    "cp",
                    f"{container}:/ficus-runtime.tar.gz",
                    str(args.output),
                ],
                check=True,
            )
        finally:
            subprocess.run(["docker", "rm", "-v", container], check=True)


if __name__ == "__main__":
    main()
