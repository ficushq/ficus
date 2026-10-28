"""Reference-only circuit verifier controls. Never used for paid inference."""

from pathlib import Path
import shlex

from harbor.agents.oracle import OracleAgent
from harbor.models.trial.paths import TrialPaths


class CircuitOracleControl(OracleAgent):
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
        if self.mode == "reference":
            return
        if self.mode == "verbose":
            code = "p=Path('/app/circopt');s=p.read_text();p.write_text(s.replace('#!/usr/bin/env python3\\n', '#!/usr/bin/env python3\\nimport os; os.write(2, b\\\"E\\\" * 524288)\\n',1))"
        elif self.mode == "no-operator-widths":
            code = "p=Path('/app/circuit/validator.py');s=p.read_text();marker='def _check_operator_widths(expr: OpCall, signals: dict[str, Signal], filename: str) -> None:\\n';assert s.count(marker)==1;p.write_text(s.replace(marker,marker+'    return\\n'))"
        elif self.mode == "wrong-xor":
            code = "p=Path('/app/circuit/evaluator.py');s=p.read_text();marker='    if op == \\\"XOR\\\":\\n';assert s.count(marker)==1;p.write_text(s.replace(marker,marker+'        return (0, args[0][1])\\n'))"
        elif self.mode == "reversed-mux":
            code = "p=Path('/app/circuit/evaluator.py');s=p.read_text();marker='a_value if sel_value == 1 else b_value';assert s.count(marker)==1;p.write_text(s.replace(marker,'b_value if sel_value == 1 else a_value'))"
        else:
            raise ValueError(self.mode)
        result = await environment.exec(
            "cd /app && python3 -c "
            + shlex.quote("from pathlib import Path\n" + code)
            + ' && git add circopt circuit && git commit -qm "Reference-only verifier control"'
        )
        if result.return_code:
            raise RuntimeError(result.stderr or result.stdout)
