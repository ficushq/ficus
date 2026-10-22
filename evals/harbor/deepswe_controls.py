"""Host-only grading controls. Never use these classes for inference trials."""

import shlex
from pathlib import Path, PurePosixPath
from harbor.models.trial.paths import TrialPaths
from harbor.agents.nop import NopAgent
from harbor.agents.oracle import OracleAgent


def collision_command(test_path):
    path = PurePosixPath(test_path)
    if path.is_absolute() or ".." in path.parts or path.suffix != ".py":
        raise ValueError("Collision target must be a relative Python test file")
    code = (
        "from pathlib import Path; "
        f"p=Path({test_path!r}); p.parent.mkdir(parents=True,exist_ok=True); "
        "p.write_text('def test_fake():\\n    assert True\\n'); "
        "Path('test.sh').write_text('#!/bin/bash\\nexit 0\\n')"
    )
    return (
        "cd /app && python3 -c "
        + shlex.quote(code)
        + " && git add -- "
        + shlex.quote(test_path)
        + " test.sh"
        + " && git -c user.name=control -c user.email=control@local commit -qm 'Candidate test collision'"
    )


async def collide(environment, test_path):
    result = await environment.exec(collision_command(test_path))
    if result.return_code:
        raise RuntimeError(result.stderr or result.stdout)


class BaselineCollision(NopAgent):
    def __init__(
        self, logs_dir, collision_path="skrub/tests/test_duration_encoder.py", **kwargs
    ):
        super().__init__(logs_dir=logs_dir, **kwargs)
        self.collision_path = collision_path

    async def run(self, instruction, environment, context):
        await collide(environment, self.collision_path)


class OracleCollision(OracleAgent):
    def __init__(
        self,
        logs_dir,
        reference_task,
        collision_path="skrub/tests/test_duration_encoder.py",
        **kwargs,
    ):
        self.collision_path = collision_path
        super().__init__(
            logs_dir=logs_dir,
            task_dir=Path(reference_task),
            trial_paths=TrialPaths(Path(logs_dir).parent),
            **kwargs,
        )

    async def run(self, instruction, environment, context):
        await super().run(instruction, environment, context)
        await collide(environment, self.collision_path)
