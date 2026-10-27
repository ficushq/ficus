"""Independently run public-contract cases on the unchanged frozen Bandit patch."""

import io
import json
from bandit.core import config, manager


def scan(source, include=("B101", "B307")):
    mgr = manager.BanditManager(
        config.BanditConfig(), "file", profile={"include": set(include)}
    )
    mgr._parse_file(
        "/tmp/audit-source.py", io.BytesIO(source.encode()), ["/tmp/audit-source.py"]
    )
    assert not mgr.skipped, mgr.skipped
    return {
        "findings": sorted([[r.lineno, r.test_id] for r in mgr.results]),
        "nosec": mgr.metrics.current["nosec"],
        "skipped_tests": mgr.metrics.current["skipped_tests"],
    }


results = {}
results["next_statement_control"] = scan(
    "value = (eval('10') +\n         eval('20'))\n# nosec-next-line B307\neval('30')\n"
)
assert results["next_statement_control"]["findings"] == [[1, "B307"], [2, "B307"]]
results["next_statement_inside_existing"] = scan(
    "value = (eval('10') +  # nosec-next-line B307\n         eval('20'))\neval('30')\n"
)
assert results["next_statement_inside_existing"]["findings"] == [[3, "B307"]]
results["inline_control"] = scan("assert eval('10') # nosec B101\nassert eval('20')\n")
assert results["inline_control"]["findings"] == [[1, "B307"], [2, "B101"], [2, "B307"]]
for kind in ("begin", "next-line"):
    results["inline_plus_" + kind] = scan(
        f"assert eval('10') # nosec B101 # nosec-{kind} B307\nassert eval('20')\n"
    )
    assert results["inline_plus_" + kind]["findings"] == [
        [1, "B101"],
        [1, "B307"],
        [2, "B101"],
    ]
# Record the enabled-set interpretation separately from independently confirmed defects.
for enabled in (("B307",), ("B101", "B307")):
    for selector in ("B307", "all", ""):
        results["metrics_" + str(enabled) + "_" + selector] = scan(
            f'# nosec-next-line {selector}\neval("10")\n', enabled
        )
# Physical dedent and explicit end interactions: observations, not a defect assertion.
for closing_indent in ("", "    "):
    src = (
        "value = (\n    eval('10')  # nosec-begin B307\n"
        + closing_indent
        + ")\n# nosec-end\n"
    )
    results["region_closing_indent_" + str(len(closing_indent))] = scan(src)
# File plugins can report a comment line with no AST statement.
results["file_comment_control"] = scan("# bidi \u202e\npass\n", ("B101", "B613"))
assert results["file_comment_control"]["findings"] == [[1, "B613"]]
for selector, metric in (("B613", "skipped_tests"), ("", "nosec")):
    results["file_comment_region_" + selector] = scan(
        f"# nosec-begin {selector}\n# bidi \u202e\n# nosec-end\npass\n",
        ("B101", "B613"),
    )
    assert results["file_comment_region_" + selector]["findings"] == [[2, "B613"]]
    assert results["file_comment_region_" + selector][metric] == 0
    results["file_assignment_region_" + selector] = scan(
        f'# nosec-begin {selector}\nvalue = "\u202e"\n# nosec-end\npass\n',
        ("B101", "B613"),
    )
    assert results["file_assignment_region_" + selector]["findings"] == []
    assert results["file_assignment_region_" + selector][metric] == 1
print(json.dumps(results, indent=2))
