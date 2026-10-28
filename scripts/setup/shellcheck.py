#!/usr/bin/env python3
"""Lint setup scripts sequentially with hard per-file time and address-space caps.

Run via `bun run lint:setup [files...]`. Findings and resource-limit failures
are errors, not skips. No full-tree ShellCheck process can grow without bound.
"""
import argparse
import ctypes
import glob
import math
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=float, default=30, help='seconds per file (maximum 30)')
    parser.add_argument('--total-timeout', type=float, default=120, help='seconds for the entire invocation (maximum 120)')
    parser.add_argument('--memory-mb', type=int, default=768, help='address space per file (maximum 768 MiB)')
    parser.add_argument('files', nargs='*')
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 30 or not math.isfinite(args.total_timeout) or not 0 < args.total_timeout <= 120 or not 0 < args.memory_mb <= 768:
        parser.error('limits must be positive and may only lower the hard caps')
    files = args.files or sorted(glob.glob(str(Path(__file__).parent / '*.sh')))
    parent = os.getpid()
    child = None

    def limits():
        resource.setrlimit(resource.RLIMIT_AS, (args.memory_mb * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(args.timeout),) * 2)
        # Linux: even an uncatchable outer harness kill must not orphan the
        # ShellCheck process. ShellCheck does not itself launch subprocesses.
        if sys.platform == 'linux':
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
                os._exit(125)
            if os.getppid() != parent:
                os._exit(125)

    def kill_group():
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()

    def cancel(signum, _frame):
        kill_group()
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    failed = False
    deadline = time.monotonic() + args.total_timeout
    for file in files:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print("ShellCheck total budget exhausted; not all files were checked", file=sys.stderr)
            return 1
        try:
            # Block cancellation across spawn/assignment so the handler always
            # knows which group it owns, including during very early setup.
            old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
            try:
                child = subprocess.Popen(['shellcheck', '-S', 'warning', '--', file], start_new_session=True, preexec_fn=limits)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
            try:
                status = child.wait(timeout=min(args.timeout, remaining))
                failed |= status != 0
                if status < 0:
                    print(f'ShellCheck killed by signal {-status}: {file} (memory/CPU cap enforced)', file=sys.stderr)
            except subprocess.TimeoutExpired:
                print(f'ShellCheck timed out after {args.timeout}s: {file}', file=sys.stderr)
                failed = True
                if time.monotonic() >= deadline:
                    print('ShellCheck total budget exhausted; not all files were checked', file=sys.stderr)
                    return 1
            finally:
                kill_group()
                child = None
        except OSError as error:
            print(f'ShellCheck could not run: {error}', file=sys.stderr)
            return 1
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
