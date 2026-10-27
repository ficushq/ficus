"""Post-delivery behavioral checks; never exposed to the repairing squad."""

import io
import json

from bandit.core import config, manager


def scan(source, include=("B101", "B307")):
    scanner = manager.BanditManager(
        config.BanditConfig(), "file", profile={"include": set(include)}
    )
    scanner._parse_file(
        "/tmp/repair-check.py", io.BytesIO(source.encode()), ["/tmp/repair-check.py"]
    )
    assert not scanner.skipped, scanner.skipped
    return {
        "findings": sorted([[r.lineno, r.test_id] for r in scanner.results]),
        "nosec": scanner.metrics.current["nosec"],
        "skipped_tests": scanner.metrics.current["skipped_tests"],
    }


cases = [
    (
        "next_statement_control",
        "value = (eval('10') +\n         eval('20'))\n# nosec-next-line B307\neval('30')\n",
        [[1, "B307"], [2, "B307"]],
        ("B101", "B307"),
        "control",
    ),
    (
        "next_statement_inside_existing",
        "value = (eval('10') +  # nosec-next-line B307\n         eval('20'))\neval('30')\n",
        [[1, "B307"], [2, "B307"]],
        ("B101", "B307"),
        "supplied_review_finding",
    ),
    (
        "inline_control",
        "assert eval('10') # nosec B101\nassert eval('20')\n",
        [[1, "B307"], [2, "B101"], [2, "B307"]],
        ("B101", "B307"),
        "control",
    ),
]
for directive in ("begin", "next-line"):
    cases.append(
        (
            "inline_plus_" + directive,
            f"assert eval('10') # nosec B101 # nosec-{directive} B307\nassert eval('20')\n",
            [[1, "B307"], [2, "B101"]],
            ("B101", "B307"),
            "supplied_review_finding",
        )
    )
for selector in ("B613", ""):
    cases.append(
        (
            "file_comment_region_" + selector,
            f"# nosec-begin {selector}\n# bidi \u202e\n# nosec-end\npass\n",
            [],
            ("B101", "B613"),
            "candidate_only_finding_not_supplied",
        )
    )
    cases.append(
        (
            "file_assignment_control_" + selector,
            f'# nosec-begin {selector}\nvalue = "\u202e"\n# nosec-end\npass\n',
            [],
            ("B101", "B613"),
            "control",
        )
    )
results = []
for name, source, expected, enabled, provenance in cases:
    actual = scan(source, enabled)
    results.append(
        {
            "name": name,
            "provenance": provenance,
            "expected_findings": expected,
            "actual": actual,
            "passed": actual["findings"] == expected,
        }
    )
print(json.dumps(results, indent=2))
