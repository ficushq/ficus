"""No-inference controls for trajectory-service grading; never inference agents."""

from pathlib import Path
import shlex

from harbor.agents.oracle import OracleAgent
from harbor.models.trial.paths import TrialPaths


class TrajectoryOracleControl(OracleAgent):
    def __init__(self, logs_dir, reference_task, mode, **kwargs):
        super().__init__(
            logs_dir=logs_dir,
            task_dir=Path(reference_task),
            trial_paths=TrialPaths(Path(logs_dir).parent),
            **kwargs,
        )
        self.mode = mode

    async def run(self, instruction, environment, context):
        await super().run(instruction, environment, context)
        overrides = {
            "verbose": "import os\nos.write(1, b'O' * 524288)\nos.write(2, b'E' * 524288)\n",
            "no-etag": "ensure_if_match = lambda *args, **kwargs: None\n",
            "no-reports": "reports_handler = lambda *args, **kwargs: {}\n",
            "no-forks": "def fork_handler(*args, **kwargs):\n    raise RuntimeError('Control: forks disabled')\n",
        }
        addition = overrides[self.mode]
        code = "from pathlib import Path\np=Path('/app/trajectory_api')\ns=p.read_text()\nmarker='if __name__ == \\\"__main__\\\":'\n".replace(
            '\\"', '"'
        )
        code += (
            "assert s.count(marker)==1\np.write_text(s.replace(marker,"
            + repr(addition)
            + "+marker))\n"
        )
        result = await environment.exec(
            "cd /app && python3 -c "
            + shlex.quote(code)
            + " && git add trajectory_api && git commit -qm 'Reference-only grader control'"
        )
        if result.return_code:
            raise RuntimeError(result.stderr or result.stdout)
