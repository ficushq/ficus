"""Post-hoc corroboration of the reviewer's finding; not a pre-registered score."""

import io
import json
from bandit.core import config, manager

results = []
for separator in ("\u2028", "\u0085", "\v"):
    for kind, source, ids in (
        (
            "region",
            f"if True:\n    # nosec-begin B101\n    text = '{separator}'\n    assert True\n",
            {"B101"},
        ),
        (
            "next_statement",
            f"# nosec-next-line B307\nvalue = ('{separator}', eval('1'))\n",
            {"B307"},
        ),
    ):
        compile(source, "/tmp/physical-lines.py", "exec")
        scanner = manager.BanditManager(
            config.BanditConfig(), "file", profile={"include": ids}
        )
        scanner._parse_file(
            "/tmp/physical-lines.py",
            io.BytesIO(source.encode()),
            ["/tmp/physical-lines.py"],
        )
        assert not scanner.skipped, scanner.skipped
        actual = sorted([[r.lineno, r.test_id] for r in scanner.results])
        results.append(
            {
                "separator": hex(ord(separator)),
                "case": kind,
                "expected": [],
                "actual": actual,
                "passed": not actual,
            }
        )
print(
    json.dumps(
        {
            "kind": "post-hoc reviewer finding corroboration, not frozen benchmark cases",
            "cases": results,
        },
        indent=2,
    )
)
