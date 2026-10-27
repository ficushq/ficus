"""Post-review reproductions on the frozen v2 delivery; never review inputs."""

import ast
import io
import json

from bandit.core import config, manager


def scan(source):
    ast.parse(source)
    scanner = manager.BanditManager(
        config.BanditConfig(), "file", profile={"include": {"B101", "B307", "B613"}}
    )
    scanner._parse_file(
        "/tmp/review-check.py", io.BytesIO(source.encode()), ["/tmp/review-check.py"]
    )
    assert not scanner.skipped, scanner.skipped
    return {
        "findings": sorted(
            [[r.lineno, r.col_offset, r.test_id] for r in scanner.results]
        ),
        "nosec": scanner.metrics.current["nosec"],
        "skipped_tests": scanner.metrics.current["skipped_tests"],
    }


sources = {
    "else_control": 'if True:\n    pass\n# ordinary comment\nelse:\n    eval("1")\neval("2")\n',
    "else_directive": 'if True:\n    pass\n# nosec-next-line B307\nelse:\n    eval("1")\neval("2")\n',
    "finally_control": 'try:\n    pass\n# ordinary comment\nfinally:\n    eval("1")\neval("2")\n',
    "finally_directive": 'try:\n    pass\n# nosec-next-line B307\nfinally:\n    eval("1")\neval("2")\n',
    "same_line_suite_control": '# ordinary comment\nif eval("0"): eval("1"); eval("2")\neval("3")\n',
    "same_line_suite_directive": '# nosec-next-line B307\nif eval("0"): eval("1"); eval("2")\neval("3")\n',
    "multiline_suite_control": '# ordinary comment\nif eval("0"):\n    eval("1"); eval("2")\neval("3")\n',
    "multiline_suite_directive": '# nosec-next-line B307\nif eval("0"):\n    eval("1"); eval("2")\neval("3")\n',
    "file_comment_control": "# ordinary comment\n# \u202e\n# nosec-end\nassert True\n",
    "file_comment_region": "# nosec-begin B613\n# \u202e\n# nosec-end\nassert True\n",
    "file_comment_legacy": "# ordinary comment\n# \u202e # nosec B613\nassert True\n",
    "semicolon_second_control": '# ordinary comment\nx = 1; y = "\u202e"\nassert True\n',
    "semicolon_second_directive": '# nosec-next-line B613\nx = 1; y = "\u202e"\nassert True\n',
    "semicolon_first_directive": '# nosec-next-line B613\nx = "\u202e"; y = 1\nassert True\n',
}
results = {name: scan(source) for name, source in sources.items()}
print(json.dumps(results, indent=2))
