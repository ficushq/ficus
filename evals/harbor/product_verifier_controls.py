"""No-inference regression control for verbose server output in product grading."""

from pathlib import Path

from harbor.agents.oracle import OracleAgent
from harbor.models.trial.paths import TrialPaths


class VerboseOracle(OracleAgent):
    def __init__(self, logs_dir, reference_task, **kwargs):
        super().__init__(
            logs_dir=logs_dir,
            task_dir=Path(reference_task),
            trial_paths=TrialPaths(Path(logs_dir).parent),
            **kwargs,
        )

    async def run(self, instruction, environment, context):
        await super().run(instruction, environment, context)
        result = await environment.exec(
            """cd /app && python3 - <<'CONTROL'
from pathlib import Path
p = Path('config_server')
p.rename('config_server_real')
p.write_text('''#!/usr/bin/env python3
import os,sys
os.write(1, b'O' * 524288)
os.write(2, b'E' * 524288)
os.execv('/app/config_server_real', ['/app/config_server_real', *sys.argv[1:]])
''')
p.chmod(0o755)
CONTROL
git add config_server config_server_real && git commit -qm 'Control: verbose server startup'"""
        )
        if result.return_code:
            raise RuntimeError(result.stderr or result.stdout)
