"""Operator-only post-hoc Pi repair checks; never an agent input or official grade.

Run with the task's Python from /app after applying a recorded implementation.
All files are temporary; no worker, network, or inference is started.
"""

import contextlib
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from mnamer import daemon


def publication_case(root, replacement):
    source = root / "incoming" / "episode.mkv"
    target = root / "library" / "episode.mkv"
    source.parent.mkdir()
    source.write_bytes(b"original-recording")
    observed = daemon.snapshot(source)
    original_link = daemon.os.link
    injected = False

    def publish(src, dst, *args, **kwargs):
        nonlocal injected
        if replacement and Path(dst) == target and not injected:
            if source.exists():
                source.unlink()
            source.write_bytes(b"new-recording")
            injected = True
        return original_link(src, dst, *args, **kwargs)

    with patch.object(daemon.os, "link", publish):
        moved = daemon.move_exclusive(source, target, observed)
    assert moved and target.read_bytes() == b"original-recording"
    if replacement:
        assert injected, "Publication injection was not exercised"
        assert source.exists(), "Unobserved replacement was removed"
        assert source.read_bytes() == b"new-recording"
    else:
        assert not source.exists()


def dry_run_case(root, collision):
    left, right, target = (root / name for name in ("left", "right", "library"))
    left.mkdir()
    right.mkdir()
    (left / "alpha.mkv").write_bytes(b"left")
    (right / ("alpha.mkv" if collision else "beta.mkv")).write_bytes(b"right")
    (right / "zeta.mkv").write_bytes(b"third")
    state = root / "state.json"
    config = {
        "watch": [
            {"path": str(folder), "movie_directory": str(target), "exclude": []}
            for folder in (left, right)
        ],
        "checks": 1,
        "interval": 0,
        "batch_size": 2,
    }
    with contextlib.redirect_stdout(io.StringIO()):
        predicted = daemon.run_cycle(state, config, True)
    assert not state.exists() and not target.exists(), "Dry-run wrote state or files"
    moved = daemon.run_cycle(state, config, False)
    assert predicted == moved, f"Predicted {predicted}, moved {moved}"
    assert len(moved) == 2


def main():
    results = []
    cases = (
        ("publication-control", publication_case, False),
        ("publication-replacement", publication_case, True),
        ("dry-run-control", dry_run_case, False),
        ("dry-run-collision", dry_run_case, True),
    )
    for name, check, variant in cases:
        with tempfile.TemporaryDirectory(prefix="mnamer-review-audit-") as temp:
            try:
                check(Path(temp), variant)
                results.append({"case": name, "passed": True})
            except Exception as exc:
                results.append({"case": name, "passed": False, "error": str(exc)})
    print(
        json.dumps(
            {
                "passed": sum(v["passed"] for v in results),
                "total": len(results),
                "results": results,
            }
        )
    )


if __name__ == "__main__":
    main()
