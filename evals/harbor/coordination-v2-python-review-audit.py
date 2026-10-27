"""Post-hoc only: mount candidate before.py/after.py at /audit in a no-network container.

These reviewer-derived cases never enter an agent environment or official grade.
"""

import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location(
    "candidate", "/audit/" + sys.argv[1] + ".py"
)
m = importlib.util.module_from_spec(spec)
sys.modules["candidate"] = m
spec.loader.exec_module(m)
cases = [
    ("literal-control", '{"b": 2}', '{"b": 2}', True),
    ("capture-control", '{"a": 2, "b": 3}', '{$K: 2, "b": $B}', True),
    ("optional-entry-splice", '{"b": 2}', '{$K?: 2, "b": $B?}', False),
    ("optional-capture-splice", '{"b": 2}', '{$K?: $V, "b": $B?}', False),
]
results = []
for name, source, pattern, want in cases:
    try:
        found = list(m.find_matches(source, pattern))
        results.append({"case": name, "passed": bool(found) == want, "matches": found})
    except ValueError as e:
        results.append({"case": name, "passed": not want, "rejected": str(e)})
print(
    json.dumps(
        {
            "revision": sys.argv[1],
            "results": results,
            "passed": sum(x["passed"] for x in results),
            "total": len(results),
        },
        default=str,
    )
)
