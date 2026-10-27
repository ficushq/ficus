"""Post-hoc reproduction of selected first-round native reviewer findings.

Run against archived before.py or after.py mounted read-only at /audit.
Not an official benchmark score; no output is provided to candidates.
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
    ("js-call-control", "javascript", "f(x);", "f($X)"),
    ("cpp-call-control", "cpp", "f(x);", "f($X)"),
    ("js-control-pattern", "javascript", "if (ready) f(x);", "if ($C) f($X);"),
    ("cpp-control-pattern", "cpp", "if (ready) f(x);", "if ($C) f($X);"),
    (
        "js-function-pattern",
        "javascript",
        "function foo(x) { return f(x); }",
        "function foo(x) { return f(x); }",
    ),
    (
        "cpp-function-pattern",
        "cpp",
        "int foo(int x) { return f(x); }",
        "int foo(int x) { return f(x); }",
    ),
    ("js-arrow-parenthesized", "javascript", "const fn = (x) => f(x);", "f($X)"),
    ("js-arrow-unparenthesized", "javascript", "const fn = x => f(x);", "f($X)"),
    ("js-empty-for", "javascript", "for (;;) f(x);", "f($X)"),
    ("cpp-empty-for", "cpp", "for (;;) f(x);", "f($X)"),
    ("cpp-range-for", "cpp", "for (auto x : items) f(x);", "f($X)"),
    ("cpp-template-member", "cpp", "obj.run<int>(a);", "$F($X)"),
    ("cpp-template-qualified", "cpp", "std::sort<int>(first,last);", "$F($A,$B)"),
]
results = []
for name, language, source, pattern in cases:
    try:
        found = list(m.find_matches(source, pattern, language))
        results.append({"case": name, "passed": len(found) == 1, "matches": found})
    except ValueError as e:
        results.append({"case": name, "passed": False, "error": str(e)})
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
