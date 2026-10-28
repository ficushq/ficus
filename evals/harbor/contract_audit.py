"""Offline completeness gate for a human/agent specification-to-test audit.

This verifies provenance and coverage, not semantic agreement. A future paid
launcher must pin the report hash and call require_ready before starting its proxy.
Historical frozen launchers and scores are deliberately untouched.
"""

import argparse
import hashlib
import json
from pathlib import Path


class AuditRejected(ValueError):
    pass


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(report, root):
    errors = []

    def reject(message):
        errors.append(message)

    if report.get("schema_version") != 1:
        reject("Unsupported audit schema")
    if report.get("stage") != "pre-inference":
        reject("Only pre-inference audits can authorize a new run")
    if report.get("decision") != "ready":
        reject("Audit decision is not ready")
    if not report.get("reviewer") or not report.get("reviewed_at_utc"):
        reject("Missing reviewer or review time")
    files = report.get("files", {})
    if not files:
        reject("No frozen input files")
    for name, expected in files.items():
        path = (root / name).resolve()
        if not path.is_relative_to(root.resolve()):
            reject(f"File escapes audited root: {name}")
        elif not path.is_file() or digest(path) != expected:
            reject(f"Input hash mismatch: {name}")
    inventory = report.get("inventory", {})
    inventory_path = root / inventory.get("file", "")
    ids = []
    if inventory.get("file") not in files:
        reject("Collected test inventory must be frozen")
    elif inventory_path.is_file():
        ids = json.loads(inventory_path.read_text())
        if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
            reject("Inventory must be a list of collected node IDs")
            ids = []
    if not ids or len(ids) != len(set(ids)):
        reject("Empty or duplicated collected test inventory")
    covered = set()
    for index, claim in enumerate(report.get("claims", [])):
        prefix = f"Claim {index}"
        nodes = claim.get("test_ids", [])
        if not nodes or set(nodes) - set(ids):
            reject(f"{prefix}: missing or unknown tests")
        if claim.get("status") != "supported":
            reject(f"{prefix}: unresolved specification/test disagreement")
        if not claim.get("rationale"):
            reject(f"{prefix}: missing interpretation rationale")
        for field in ("spec_evidence", "test_evidence"):
            evidence = claim.get(field, [])
            if not evidence:
                reject(f"{prefix}: missing {field}")
            for entry in evidence:
                file = entry.get("file")
                quote = entry.get("quote")
                if file not in files or not isinstance(quote, str) or not quote.strip():
                    reject(f"{prefix}: unfrozen or empty {field}")
                elif (
                    not (root / file).is_file()
                    or quote not in (root / file).read_text()
                ):
                    reject(f"{prefix}: {field} quote not found")
        covered.update(nodes)
    if set(ids) - covered:
        reject(f"Unaudited tests: {len(set(ids) - covered)}")
    if report.get("unresolved_findings"):
        reject("Unresolved findings remain")
    return errors


def require_ready(report_path, root, expected_sha256):
    if digest(report_path) != expected_sha256:
        raise AuditRejected("Audit report hash mismatch")
    errors = validate(json.loads(report_path.read_text()), root)
    if errors:
        raise AuditRejected("; ".join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        require_ready(args.report, args.root, args.sha256)
    except (AuditRejected, OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"Contract audit blocked: {error}\n")
    print(
        "Contract audit provenance and coverage verified; semantic review remains attested."
    )


if __name__ == "__main__":
    main()
