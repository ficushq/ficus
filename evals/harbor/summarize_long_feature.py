"""Summarize a frozen four-arm run without exposing prompts, keys, or solutions."""

import argparse
import hashlib
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from budget_proxy import Budget

ARMS = ("ficus-planned", "pi-planned", "ficus-engineer", "pi-engineer")


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def seconds(timing):
    if not timing or not timing.get("finished_at"):
        return None
    return round(
        (
            datetime.fromisoformat(timing["finished_at"])
            - datetime.fromisoformat(timing["started_at"])
        ).total_seconds(),
        2,
    )


def summarize(jobs, ledger, frozen, prefix):
    rows = []
    with sqlite3.connect(f"file:{ledger}?mode=ro", uri=True) as db:
        exposure = Budget.exposure(db) / 1e6
        for arm in ARMS:
            client = f"{prefix}-{arm}"
            files = list((jobs / client).glob("*/result.json"))
            if not files:
                continue
            if len(files) != 1:
                raise ValueError(f"Unexpected multiple attempts for {client}")
            result_path = files[0]
            result = json.loads(result_path.read_text())
            if not result.get("finished_at"):
                continue
            trial = result_path.parent
            calls = db.execute(
                "SELECT charge,usage FROM calls WHERE client=?", (client,)
            ).fetchall()
            artifacts = [result_path]
            for name in (
                "verifier/reward.json",
                "verifier/ctrf.json",
                "verifier/test-stdout.txt",
                "agent/snapshot.json",
                "agent/messages.json",
                "agent/progress.jsonl",
                "agent/pi.txt",
            ):
                if (trial / name).exists():
                    artifacts.append(trial / name)
            patches = list((trial / "artifacts").rglob("model.patch"))
            artifacts.extend(patches)
            row = {
                "arm": arm,
                "job_name": client,
                "reward": (result.get("verifier_result") or {}).get("rewards"),
                "exception": result.get("exception_info"),
                "agent_metadata": (result.get("agent_result") or {}).get("metadata"),
                "total_seconds": seconds(result),
                "timing_seconds": {
                    key: seconds(result.get(key))
                    for key in (
                        "environment_setup",
                        "agent_setup",
                        "agent_execution",
                        "verifier",
                    )
                },
                "requests": len(calls),
                "confirmed_cost_usd": round(
                    sum(cost for cost, usage in calls if usage is not None) / 1e6, 6
                ),
                "unknown_usage_requests": sum(usage is None for _, usage in calls),
                "submitted_patch_bytes": sum(p.stat().st_size for p in patches),
                "artifacts_sha256": {
                    str(p.relative_to(trial)): sha(p) for p in artifacts
                },
                "operator_task_interventions": 0,
                "human_attention_minutes": None,
            }
            progress = trial / "agent/progress.jsonl"
            if progress.exists():
                observations = [
                    json.loads(line) for line in progress.read_text().splitlines()
                ]
                row["observed_human_question_agents"] = sorted(
                    {
                        a[0]
                        for obs in observations
                        for a in obs["agents"]
                        if a[3] or a[2] == "waiting-input"
                    }
                )
                row["state_transition_count"] = len(observations)
            snapshot = trial / "agent/snapshot.json"
            if snapshot.exists():
                state = json.loads(snapshot.read_text())
                row["review_attempts"] = sum(
                    a["stepId"] == "review"
                    for f in state.get("flows", [])
                    for a in f["state"]["attempts"]
                )
                row["stream_statuses"] = [s["status"] for s in state["streams"]]
            rows.append(row)
    return {
        "experiment": "long-feature-v1",
        "frozen_manifest_sha256": sha(frozen),
        "results": rows,
        "complete_matched_comparison": len(rows) == 4
        and all(
            r["exception"] is None
            and r["unknown_usage_requests"] == 0
            and r["reward"] is not None
            for r in rows
        ),
        "cumulative_exposure_usd": exposure,
        "cap_usd": 50,
        "new_confirmed_usd": round(sum(r["confirmed_cost_usd"] for r in rows), 6),
        "limitations": [
            "Single restricted task, one attempt per arm",
            "Shared Apple Silicon host with amd64 task emulation",
            "Ficus adds capped database compute",
            "Host-wide inference proxy allowlist",
            "No measured human time saved; infrastructure effort not timed",
            "Stop on cumulative or per-arm reservation cap; preserve incomplete comparisons",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--frozen", type=Path, required=True)
    parser.add_argument("--prefix", default="long-v1-skrub")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = summarize(args.jobs, args.ledger, args.frozen, args.prefix)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for row in report["results"]:
        print(
            row["arm"], row["reward"], row["confirmed_cost_usd"], row["total_seconds"]
        )
    print(
        "Complete:",
        report["complete_matched_comparison"],
        "Cumulative exposure:",
        report["cumulative_exposure_usd"],
    )
