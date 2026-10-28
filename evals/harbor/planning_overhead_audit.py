"""Read-only native planning audit. Does not inspect private reasoning or call models."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def text_size(result):
    try:
        obj = json.loads(result)
    except (ValueError, TypeError):
        return len(result or "")
    return sum(
        len(b.get("text", ""))
        for b in obj.get("content", [])
        if b.get("type") == "text"
    )


def audit(directory):
    snapshot_path = directory / "snapshot.json"
    messages_path = directory / "messages.json"
    snapshot = json.loads(snapshot_path.read_text())
    messages = json.loads(messages_path.read_text())
    architects = {
        a["id"] for a in snapshot["agents"] if a["agentTypeId"] == "architect"
    }
    streams = {s["id"]: s["title"] for s in snapshot["streams"]}
    output = []
    for agent in sorted(architects):
        usage = [u for u in snapshot["usage"] if u["agentId"] == agent]
        tools = []
        for message in messages:
            if message["agentId"] != agent:
                continue
            for block in (message.get("metadata") or {}).get("content", []):
                if block.get("type") != "tool_use":
                    continue
                tool = block.get("toolCall") or {}
                arguments = json.loads(tool.get("args", "{}"))
                command = arguments.get("command", "")
                flags = []
                for label, matches in {
                    "original_source_read": [
                        "cat /tmp/circopt-task/ORIGINAL_REQUEST.md"
                    ],
                    "native_state_read": [
                        "workstream get",
                        "workstream flow",
                        "squad agents",
                    ],
                    "plan_write": ["PLAN.md <<"],
                    "handoff_or_inbox": ["inbox send", "workstream advance"],
                    "plan_read": [
                        "cat /tmp/circopt-task/",
                        "---PLANS---",
                        "---CORE PLAN SUMMARY---",
                    ],
                }.items():
                    if any(value in command for value in matches):
                        flags.append(label)
                tools.append(
                    {
                        "message_id": message["id"],
                        "tool": tool.get("toolName"),
                        "flags_nonexclusive": flags,
                        "argument_chars": len(tool.get("args", "")),
                        "returned_text_chars": text_size(tool.get("result", "")),
                        "error": bool(tool.get("isError")),
                        "output_limit_rejection": "response hit the output token limit"
                        in tool.get("result", ""),
                    }
                )
        output.append(
            {
                "agent": agent,
                "stream": streams[usage[0]["workStreamId"]],
                "calls": len(usage),
                "native_usd": sum(u["costNanodollars"] for u in usage) / 1e9,
                "output_tokens": sum(u["outputTokens"] for u in usage),
                "cache_read_tokens": sum(u["cacheReadTokens"] for u in usage),
                "cache_write_tokens": sum(u["cacheWriteTokens"] for u in usage),
                "tool_count": len(tools),
                "returned_text_chars": sum(t["returned_text_chars"] for t in tools),
                "successful_plan_argument_chars": sum(
                    t["argument_chars"]
                    for t in tools
                    if "plan_write" in t["flags_nonexclusive"] and not t["error"]
                ),
                "flags_nonexclusive": dict(
                    Counter(f for t in tools for f in t["flags_nonexclusive"])
                ),
                "length_stop_receipts": [
                    {
                        "response_id": u["source"]["responseId"],
                        "output_tokens": u["outputTokens"],
                        "native_usd": u["costNanodollars"] / 1e9,
                    }
                    for u in usage
                    if u.get("source", {}).get("stopReason") == "length"
                ],
                "tools": tools,
            }
        )
    return {
        "study": "coordination-v8-planning-overhead",
        "method": "Explicit tool args/results and usage only. Character sizes are not tokens or additive billable savings; flags overlap. Every receipt attributed to an architect execution, not guessed sub-actions.",
        "evidence_sha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (snapshot_path, messages_path)
        },
        "architects": output,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("agent_directory", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(audit(args.agent_directory), indent=2) + "\n")
