"""Capture a real OS pipe, not Bun.spawn's socket-backed stdio.

Only synthetic CLI tests use this helper. Emit the exact captured bytes and
producer exit code; a bounded slow reader exposes backpressure without hanging CI.
"""
import subprocess
import sys
import tempfile
import threading
import time

slow = sys.argv[1] == "slow-pipe"
with tempfile.TemporaryFile() as errors:
    child = subprocess.Popen(sys.argv[2:], stdout=subprocess.PIPE, stderr=errors)
    timer = threading.Timer(10, child.kill)
    timer.start()
    try:
        if slow:
            time.sleep(0.1)
            chunks = []
            while chunk := child.stdout.read(1021):
                chunks.append(chunk)
                time.sleep(0.001)
            captured = b"".join(chunks)
            child.wait(timeout=2)
        else:
            captured, _ = child.communicate(timeout=10)
        sys.stdout.buffer.write(captured)
        errors.seek(0)
        sys.stderr.buffer.write(errors.read())
    finally:
        timer.cancel()
        timer.join()
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
