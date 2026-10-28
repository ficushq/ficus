import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

r = Path("/logs/verifier")
try:
    root = ET.parse(r / "results.xml").getroot()
    cases = list(root.iter("testcase"))
    failures = sum(
        c.find("failure") is not None or c.find("error") is not None for c in cases
    )
    skipped = sum(c.find("skipped") is not None for c in cases)
    count = len(cases)
except (ET.ParseError, OSError):
    count = failures = skipped = 0
passed = count - failures - skipped
expected = int(Path("/tests/expected-count.txt").read_text())
accepted = (
    sys.argv[1] == "0" and expected > 0 and count == expected and passed == expected
)
(r / "counts.json").write_text(
    json.dumps(
        dict(
            total=count,
            passed=passed,
            failures=failures,
            skipped=skipped,
            accepted=accepted,
        )
    )
)
(r / "reward.txt").write_text("1" if accepted else "0")
