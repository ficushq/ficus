"""Host-only grading controls. Never use these classes for inference trials."""

from pathlib import Path
from harbor.models.trial.paths import TrialPaths
from harbor.agents.nop import NopAgent
from harbor.agents.oracle import OracleAgent


async def collide(environment):
    result = await environment.exec(r"""cd /app && python3 - <<'SCRIPT'
from pathlib import Path
Path('skrub/tests/test_duration_encoder.py').write_text('def test_fake():\n    assert True\n')
Path('test.sh').write_text('#!/bin/bash\nexit 0\n')
SCRIPT
 git add skrub/tests/test_duration_encoder.py test.sh && git -c user.name=control -c user.email=control@local commit -qm 'Candidate test collision'""")
    if result.return_code:
        raise RuntimeError(result.stderr or result.stdout)


class BaselineCollision(NopAgent):
    async def run(self, instruction, environment, context):
        await collide(environment)


class OracleCollision(OracleAgent):
    def __init__(self, logs_dir, reference_task, **kwargs):
        super().__init__(
            logs_dir=logs_dir,
            task_dir=Path(reference_task),
            trial_paths=TrialPaths(Path(logs_dir).parent),
            **kwargs,
        )

    async def run(self, instruction, environment, context):
        await super().run(instruction, environment, context)
        await collide(environment)
