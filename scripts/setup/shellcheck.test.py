"""Real, small subprocesses stand in for ShellCheck; never lint the setup tree here."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

WRAPPER = Path(__file__).with_name('shellcheck.py')

class BoundedShellcheck(unittest.TestCase):
    def run_fake(self, code, *args):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        fake = root / 'shellcheck'
        fake.write_text('#!' + sys.executable + '\n' + code)
        fake.chmod(0o755)
        return subprocess.Popen([sys.executable, str(WRAPPER), '--timeout', '0.3', '--memory-mb', '128', *args, 'first.sh', 'second.sh'], env={**os.environ, 'PATH': str(root) + ':' + os.environ['PATH']}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_findings_propagate_and_each_file_is_separate(self):
        p = self.run_fake('import sys\nprint(sys.argv[-1], flush=True)\nsys.exit(1)\n')
        out, _ = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(out.decode().splitlines(), ['first.sh', 'second.sh'])

    def test_timeout_kills_term_resistant_child(self):
        p = self.run_fake('import signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)\n')
        _, err = p.communicate(timeout=5)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('timed out', err.decode())

    def test_memory_limit_is_applied(self):
        p = self.run_fake('import resource\nprint(resource.getrlimit(resource.RLIMIT_AS)[0], flush=True)\n')
        out, _ = p.communicate(timeout=5)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(out.decode().splitlines(), [str(128 * 1024 * 1024)] * 2)

    def test_total_invocation_budget_is_bounded(self):
        p = self.run_fake('import time\ntime.sleep(0.15)\n', '--total-timeout', '0.2')
        _, err = p.communicate(timeout=5)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('total budget', err.decode())

    @unittest.skipUnless(sys.platform == 'linux', 'Linux parent-death safety net')
    def test_uncatchable_harness_kill_does_not_orphan_shellcheck(self):
        p = self.run_fake('import os,time\nprint(os.getpid(), flush=True)\ntime.sleep(60)\n')
        pid = int(p.stdout.readline())
        try:
            p.kill()
            p.communicate(timeout=3)  # child-held pipes must close too
            self.assertEqual(p.returncode, -signal.SIGKILL)
        finally:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.wait()

    def test_cancel_kills_entire_child_group(self):
        p = self.run_fake('import subprocess,signal,time\nsubprocess.Popen(["sleep", "60"])\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("ready", flush=True)\ntime.sleep(60)\n')
        try:
            self.assertEqual(p.stdout.readline(), b'ready\n')
            p.send_signal(signal.SIGTERM)
            _, err = p.communicate(timeout=5)
            self.assertEqual(p.returncode, 143)
        finally:
            if p.poll() is None: p.kill()
            p.wait()

if __name__ == '__main__':
    unittest.main()
