"""Grade an already captured artifact without inference; never a new agent attempt."""

import hashlib
import shlex
from pathlib import Path

from harbor.agents.nop import NopAgent


class CapturedArtifact(NopAgent):
    def __init__(self, logs_dir, patch_path, patch_sha256, base_commit, **kwargs):
        super().__init__(logs_dir=logs_dir, **kwargs)
        self.patch_path = Path(patch_path)
        self.patch_sha256 = patch_sha256
        self.base_commit = base_commit

    async def run(self, instruction, environment, context):
        digest = hashlib.sha256(self.patch_path.read_bytes()).hexdigest()
        if digest != self.patch_sha256:
            raise ValueError("Captured artifact drift")
        destination = "/tmp/captured-artifact.patch"
        await environment.upload_file(self.patch_path, destination)
        result = await environment.exec(
            "cd /app && git reset --hard "
            + shlex.quote(self.base_commit)
            + " && git apply --index "
            + shlex.quote(destination)
            + " && git -c user.name=artifact-review -c user.email=review@local "
            "commit -qm 'Replay captured artifact for grading'"
        )
        if result.return_code:
            raise RuntimeError(result.stderr or result.stdout)
        context.metadata = {
            "inference": False,
            "captured_artifact_sha256": digest,
            "delivery_claim": False,
        }
