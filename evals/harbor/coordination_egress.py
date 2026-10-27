"""Explicit, process-local Harbor timeout override for coordination diagnostics.

Copy the pinned sidecar build context rather than editing the installed Harbor
package. Preserve sniffing, allowlists and verifier isolation byte for byte.
"""

import atexit
import hashlib
import shutil
import tempfile
from pathlib import Path

from harbor.environments.docker.docker import DockerEnvironment

_context = None
_evidence = None


def patch_config(text):
    anchor = "        sniffing: true\n"
    if text.count(anchor) != 1 or "readTimeout:" in text:
        raise ValueError("Unexpected Harbor egress configuration")
    return text.replace(anchor, "        readTimeout: 600s\n" + anchor)


def configure_timeout(seconds):
    global _context, _evidence
    if seconds is None:
        return None
    if seconds != 600:
        raise ValueError("Only the declared 600-second diagnostic is supported")
    if _evidence is not None:
        return _evidence
    source = DockerEnvironment._EGRESS_CONTROL_SIDECAR_CONTEXT_PATH
    _context = tempfile.TemporaryDirectory(prefix="ficus-coordination-egress-")
    atexit.register(_context.cleanup)
    target = Path(_context.name) / "context"
    shutil.copytree(source, target)
    config = target / "gost.yaml"
    original = config.read_text()
    config.write_text(patch_config(original))
    _evidence = {
        "response_header_timeout_seconds": seconds,
        "original_config_sha256": hashlib.sha256(original.encode()).hexdigest(),
        "context_sha256": {
            str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(target.rglob("*"))
            if p.is_file()
        },
        "network_policy_unchanged": True,
    }
    DockerEnvironment._EGRESS_CONTROL_SIDECAR_CONTEXT_PATH = target
    return _evidence
