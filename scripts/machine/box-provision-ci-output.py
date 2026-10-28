#!/usr/bin/env python3
"""Bound a disposable-CI phase record, never silently discard its diagnosis.

Ordinary output is byte-for-byte complete. Oversize output is a capture failure,
not successful evidence: retain head/tail and the lock-timeout marker separately.
Drain the pipe so only the existing producer deadline controls process lifetime.
"""
import re
import sys

LIMIT = 128 * 1024
head = bytearray()
tail = b""
window = b""
lock_marker = b""
total = 0
while chunk := sys.stdin.buffer.read(16 * 1024):
    total += len(chunk)
    head.extend(chunk[: max(0, LIMIT - len(head))])
    tail = (tail + chunk)[-LIMIT // 2 :]
    window += chunk
    for match in re.finditer(rb"FICUS_BOX_LOCK_TIMEOUT[^\r\n]*[\r\n]", window):
        lock_marker = match[0][:4096].rstrip(b"\r\n")
    window = window[-4096:]
# Also retain a marker on a final line without a newline.
for match in re.finditer(rb"FICUS_BOX_LOCK_TIMEOUT[^\r\n]*", window):
    lock_marker = match[0][:4096]

with open(sys.argv[1], "wb") as record:
    if total <= LIMIT:
        record.write(head)
    else:
        record.write(head[: LIMIT // 2])
        record.write(
            f"\nFICUS_CI_PROVISION_OUTPUT_LIMIT bytes={total} limit={LIMIT} "
            f"omitted_bytes={total - LIMIT}; capture FAILED; head/tail follow\n".encode()
        )
        record.write(tail)
        if lock_marker:
            record.write(b"\nRetained lock diagnosis: " + lock_marker + b"\n")
sys.exit(74 if total > LIMIT else 0)
