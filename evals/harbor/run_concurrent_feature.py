"""Run frozen two-task batches; retain failures and never retry model attempts."""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from budget_proxy import Budget
from summarize_long_feature import ARMS, sha, summarize


def validate_inputs(repo, tasks, manifest, runtime):
    for name, expected in manifest["source_files_sha256"].items():
        if sha(repo / name) != expected:
            raise ValueError(f"Source drift: {name}")
    for task in manifest["tasks"]:
        for name, expected in task["prepared_file_sha256"].items():
            if sha(tasks / task["task"] / name) != expected:
                raise ValueError(f"Task drift: {task['task']}/{name}")
    if sha(runtime) != manifest["runtime_archive_sha256"]:
        raise ValueError("Runtime drift")


def job_prefix(manifest, task):
    prefix = manifest.get("job_prefix", "cv1")
    for value in (prefix, task["short"]):
        if not isinstance(value, str) or not re.fullmatch(
            r"[a-z0-9]+(?:-[a-z0-9]+)*", value
        ):
            raise ValueError("Invalid job namespace")
    return f"{prefix}-{task['short']}"


def summarize_batches(jobs, ledger, frozen, manifest):
    tasks = []
    for task in manifest["tasks"]:
        report = summarize(jobs, ledger, frozen, job_prefix(manifest, task))
        report["results"] = [
            r for r in report["results"] if r["arm"] in manifest["arms"]
        ]
        report["new_confirmed_usd"] = round(
            sum(r["confirmed_cost_usd"] for r in report["results"]), 6
        )
        report["complete_matched_comparison"] = (
            set(manifest["arms"]) == set(ARMS) and report["complete_matched_comparison"]
        )
        report["cap_usd"] = manifest.get("cumulative_cap_usd", 50)
        report["task"] = task["task"]
        tasks.append(report)
    batches = []
    for arm in manifest["arms"]:
        timing = jobs / f"{arm}-batch.json"
        if not timing.exists():
            continue
        batch = json.loads(timing.read_text())
        rows = [r for t in tasks for r in t["results"] if r["arm"] == arm]
        accepted = sum(
            r["exception"] is None and (r["reward"] or {}).get("reward") == 1
            for r in rows
        )
        duration = batch.get("elapsed_seconds")
        complete = (
            len(rows) == len(manifest["tasks"])
            and all(
                r["exception"] is None
                and r["unknown_usage_requests"] == 0
                and r["reward"] is not None
                for r in rows
            )
            and all(batch.get("exit_codes", {}).get(r["job_name"]) == 0 for r in rows)
        )
        batch.update(
            complete=complete,
            accepted_tasks=accepted,
            finished_attempts=len(rows),
            completed_tasks=sum(
                r["exception"] is None and r["reward"] is not None for r in rows
            ),
            accepted_tasks_per_hour=round(accepted * 3600 / duration, 4)
            if complete and duration
            else None,
            inference_usd=round(sum(r["confirmed_cost_usd"] for r in rows), 6),
        )
        batches.append(batch)
    return {
        "experiment": manifest.get("experiment", "concurrent-feature-v1"),
        "complete_requested_batches": len(batches) == len(manifest["arms"])
        and all(b["complete"] for b in batches),
        "frozen_manifest_sha256": sha(frozen),
        "tasks": tasks,
        "batches": batches,
        "complete_matched_comparison": len(batches) == len(manifest["arms"])
        and all(b["complete"] for b in batches)
        and all(t["complete_matched_comparison"] for t in tasks),
        "cumulative_exposure_usd": tasks[0]["cumulative_exposure_usd"],
        "new_confirmed_usd": round(sum(t["new_confirmed_usd"] for t in tasks), 6),
        "human_attention_minutes": None,
    }


def check_provider_failures(ledger, clients):
    with sqlite3.connect(f"file:{ledger}?mode=ro", uri=True) as db:
        for client in clients:
            rejected = db.execute(
                "SELECT id FROM rejections WHERE client=? ORDER BY id LIMIT 1",
                (client,),
            ).fetchone()
            if rejected:
                raise ValueError(
                    f"Local budget rejection for {client}, event {rejected[0]}"
                )
            row = db.execute(
                "SELECT id,failure,http_status FROM calls WHERE client=? "
                "AND ((failure IS NOT NULL AND failure!='client_disconnected') "
                "OR http_status>=400) ORDER BY id LIMIT 1",
                (client,),
            ).fetchone()
            if row:
                raise ValueError(
                    f"Provider failure for {client}, call {row[0]}; stop batch without retry"
                )


def run(args):
    repo = Path(__file__).resolve().parents[2]
    manifest = json.loads(args.frozen.read_text())
    if sha(args.frozen) != args.frozen_sha256:
        raise ValueError("Manifest drift")
    if len(manifest["tasks"]) != 2 or manifest["concurrency"] != 2:
        raise ValueError("This runner requires a frozen two-task batch")
    if (
        not manifest["arms"]
        or len(set(manifest["arms"])) != len(manifest["arms"])
        or not set(manifest["arms"]) <= set(ARMS)
    ):
        raise ValueError("Invalid or repeated arms")
    prefixes = [job_prefix(manifest, task) for task in manifest["tasks"]]
    if len(set(prefixes)) != len(prefixes):
        raise ValueError("Repeated task namespace")
    args.jobs.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env["PATH"]
    env.pop("DOCKER_DEFAULT_PLATFORM", None)
    for arm in manifest["arms"]:
        validate_inputs(repo, args.tasks, manifest, args.runtime)
        names = [f"{job_prefix(manifest, t)}-{arm}" for t in manifest["tasks"]]
        with sqlite3.connect(f"file:{args.ledger}?mode=ro", uri=True) as db:
            if any(
                db.execute(
                    "SELECT 1 FROM calls WHERE client=? LIMIT 1", (name,)
                ).fetchone()
                for name in names
            ):
                raise ValueError("Refusing to reuse an existing inference client")
            if db.execute(
                "SELECT count(*) FROM calls WHERE id>? AND usage IS NULL",
                (manifest["prior_last_call_id"],),
            ).fetchone()[0]:
                raise ValueError("Unresolved usage; stop before next batch")
            if (
                Budget.exposure(db) + 2 * 5_500_000
                > manifest["cumulative_cap_usd"] * 1e6
            ):
                raise ValueError(
                    "Insufficient global headroom for two request reservations"
                )
        batch_file = args.jobs / f"{arm}-batch.json"
        if batch_file.exists() or any((args.jobs / n).exists() for n in names):
            raise ValueError("Refusing to retry an existing batch")
        batch = {
            "arm": arm,
            "started_at": datetime.now(UTC).isoformat(),
            "jobs": names,
            "exit_codes": {},
            "concurrency": 2,
        }
        batch_file.write_text(json.dumps(batch, indent=2) + "\n")
        children = []
        start = time.monotonic()
        try:
            for task, name in zip(manifest["tasks"], names, strict=True):
                harness, workflow = arm.split("-")
                command = [
                    sys.executable,
                    str(repo / "evals/harbor/run-pilot.py"),
                    harness,
                    str(args.tasks / task["task"]),
                    "--workflow",
                    workflow,
                    "--access",
                    str(args.access),
                    "--client",
                    name,
                    "--runtime-archive",
                    str(args.runtime),
                    "--jobs-dir",
                    str(args.jobs),
                    "--job-name",
                    name,
                    "--restricted-network",
                ]
                out = (args.jobs / f"{name}.log").open("w")
                try:
                    child = subprocess.Popen(
                        command, cwd=repo, env=env, stdout=out, stderr=subprocess.STDOUT
                    )
                except BaseException:
                    out.close()
                    raise
                children.append((name, child, out))
                print("START", name, flush=True)
            while True:
                check_provider_failures(args.ledger, names)
                for name, child, _ in children:
                    if name not in batch["exit_codes"] and child.poll() is not None:
                        batch["exit_codes"][name] = child.returncode
                        print("FINISH", name, child.returncode, flush=True)
                if len(batch["exit_codes"]) == len(children):
                    break
                time.sleep(1)
        except BaseException as error:
            batch["stop_reason"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            for name, child, out in children:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=60)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                batch["exit_codes"][name] = child.returncode
                out.close()
            batch.update(
                finished_at=datetime.now(UTC).isoformat(),
                elapsed_seconds=round(time.monotonic() - start, 2),
            )
            batch_file.write_text(json.dumps(batch, indent=2) + "\n")
        validate_inputs(repo, args.tasks, manifest, args.runtime)
        report = summarize_batches(args.jobs, args.ledger, args.frozen, manifest)
        (args.jobs / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
        rows = [r for t in report["tasks"] for r in t["results"] if r["arm"] == arm]
        if (
            len(rows) != 2
            or any(batch["exit_codes"].get(n) != 0 for n in names)
            or any(
                r["exception"] or r["unknown_usage_requests"] or r["reward"] is None
                for r in rows
            )
        ):
            raise ValueError(
                "Incomplete/infrastructure/budget failure; remaining batches stopped"
            )
        print(
            "BATCH",
            arm,
            "complete; cumulative",
            report["cumulative_exposure_usd"],
            flush=True,
        )
    print("ALL BATCHES COMPLETE", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("frozen", "tasks", "runtime", "jobs", "ledger", "access"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--frozen-sha256", required=True)
    run(parser.parse_args())
