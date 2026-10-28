"""No-inference reference/negative controls; never supplied to paid candidates."""

from pathlib import Path
import shlex
from harbor.agents.oracle import OracleAgent
from harbor.models.trial.paths import TrialPaths


class LongitudinalControl(OracleAgent):
    def __init__(self, logs_dir, reference_task, mode, **kwargs):
        super().__init__(
            logs_dir=logs_dir,
            task_dir=Path(reference_task),
            trial_paths=TrialPaths(Path(logs_dir).parent),
            **kwargs,
        )
        if mode not in {"reference", "noisy-collision", "mutations", "missing", "noop"}:
            raise ValueError(mode)
        self.mode = mode

    async def run(self, instruction, environment, context):
        await super().run(instruction, environment, context)
        if self.mode == "reference":
            return
        if self.mode == "missing":
            result = await environment.exec("rm /logs/artifacts/increment-2.patch")
            if result.return_code:
                raise RuntimeError("Missing-artifact control setup failed")
            return
        for index in range(1, 4):
            # Oracle snapshots are deliberately replaced only in this named control.
            code = "from pathlib import Path\np=Path('/app/datagate');s=p.read_text()\n"
            if self.mode == "noop":
                noop = "#!/usr/bin/env python3\nimport argparse,json\nfrom http.server import BaseHTTPRequestHandler,HTTPServer\np=argparse.ArgumentParser();p.add_argument('start');p.add_argument('--port',type=int);p.add_argument('--address');a=p.parse_args()\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(404);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{\"ok\":false,\"error\":\"No implementation\"}')\n def log_message(self,*args): pass\nHTTPServer((a.address,a.port),H).serve_forever()\n"
                code += "s=" + repr(noop) + "\n"
            elif self.mode == "noisy-collision":
                marker = 'if __name__ == "__main__":'
                replacement = (
                    'import os\nos.write(1, b"O" * 524288)\nos.write(2, b"E" * 524288)\n'
                    + marker
                )
                code += f"assert s.count({marker!r}) == 1\ns=s.replace({marker!r}, {replacement!r})\n"
                code += "Path('/app/conftest.py').write_text('raise RuntimeError(\"Candidate conftest must not load\")\\n')\nPath('/app/_helpers.py').write_text('raise RuntimeError(\"Candidate helper must not load\")\\n')\n"
            else:
                changes = {
                    1: (
                        "def _coerce_numeric(value: str) -> int | float:\n",
                        "def _coerce_numeric(value: str) -> int | float:\n    return value\n",
                    ),
                    2: ("reverse=options.sort_desc", "reverse=not options.sort_desc"),
                    3: (
                        "def _matches_filters(row: list[str | int | float], filters: list[RowFilter]) -> bool:\n",
                        "def _matches_filters(row: list[str | int | float], filters: list[RowFilter]) -> bool:\n    return True\n",
                    ),
                }
                old, new = changes[index]
                code += f"assert s.count({old!r}) == 1\ns=s.replace({old!r}, {new!r})\n"
            code += "p.write_text(s)\n"
            cmd = (
                f"cd /app && git checkout --detach -q $(cat /logs/artifacts/increment-{index}.head) && python3 -c "
                + shlex.quote(code)
                + f' && git add datagate . && git commit -qm "Reference-only {self.mode} control" && git diff --binary baseline HEAD > /logs/artifacts/increment-{index}.patch && git rev-parse HEAD > /logs/artifacts/increment-{index}.head && git bundle create /logs/artifacts/increment-{index}.bundle --all'
            )
            result = await environment.exec(cmd, timeout_sec=60)
            if result.return_code:
                raise RuntimeError(result.stderr or result.stdout)
