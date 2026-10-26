"""Offline causal probe only; never supplied to agents or a benchmark repair.

Run in a disposable container with the exact delivered Bandit patch applied.
The temporary source mutation checks whether retaining physical region coverage
explains the frozen File-plugin failures. It is not a reviewed production fix.
"""

from pathlib import Path
import subprocess
import sys

path = Path("/app/bandit/core/nosec.py")
source = path.read_text()
changes = (
    (
        "        self.statements = {}",
        "        self.statements = {}\n        self.physical = {}",
    ),
    (
        "        return combine(*(",
        "        return combine(self.physical.get(result.lineno), *(",
    ),
    ("    physical = {}", "    physical = result.physical"),
)
for before, after in changes:
    assert source.count(before) == 1, repr(before)
    source = source.replace(before, after)
path.write_text(source)
subprocess.run([sys.executable, "/tmp/check.py"], check=True)
