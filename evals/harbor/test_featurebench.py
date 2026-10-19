import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from prepare_featurebench import RESTORE, SANITIZE


class FeatureBenchIsolationTests(unittest.TestCase):
    def test_masked_git_has_no_answer_and_grading_restores_only_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "testbed"
            repo.mkdir()
            temp = root / "tmp"
            temp.mkdir()
            private = root / "root"
            private.mkdir()
            (private / "my_repo").mkdir()
            (private / "my_repo/answer.py").write_text("answer material")
            fixtures = root / "tests/fixtures"
            fixtures.mkdir(parents=True)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=repo, text=True)

            git("init", "-q")
            git("config", "user.email", "fixture@localhost")
            git("config", "user.name", "Fixture")
            source = repo / "implementation.py"
            source.write_text("ANSWER = 'hidden-original-answer'\n")
            git("add", "-A")
            git("commit", "-qm", "original")
            source.write_text("raise NotImplementedError\n")
            mask = git("diff")
            (temp / "setup_patch.diff").write_text(mask)
            (temp / "test_patch.diff").write_text("hidden test fixture")
            (repo / "__pycache__").mkdir()
            (repo / "__pycache__/answer.pyc").write_bytes(b"old bytecode")
            with tarfile.open(fixtures / "original-git.tar.gz", "w:gz") as archive:
                archive.add(repo / ".git", arcname=".git")
            for name in ("setup_patch.diff", "test_patch.diff"):
                (fixtures / name).write_bytes((temp / name).read_bytes())
            for name in ("image_baseline_status.txt", "image_baseline_diff_hash.txt"):
                (fixtures / name).write_text("fixture")
            script = (
                SANITIZE.replace("/testbed", str(repo))
                .replace("/root/", str(private) + "/")
                .replace("/tmp/", str(temp) + "/")
            )
            subprocess.run(["bash", "-c", script], check=True, capture_output=True)
            self.assertEqual(git("rev-list", "--all", "--count").strip(), "1")
            self.assertNotIn(
                "hidden-original-answer", git("show", "HEAD:implementation.py")
            )
            self.assertEqual(git("fsck", "--no-reflogs", "--unreachable"), "")
            self.assertFalse((temp / "setup_patch.diff").exists())
            self.assertFalse((private / "my_repo").exists())
            self.assertFalse((repo / "__pycache__").exists())
            # An agent's new implementation survives restoration of grader history.
            source.write_text("ANSWER = 'agent implementation'\n")
            restore = root / "tests/restore.sh"
            restore.write_text(
                RESTORE.replace("/testbed", str(repo)).replace("/tmp/", str(temp) + "/")
            )
            subprocess.run(["bash", str(restore)], check=True, capture_output=True)
            self.assertEqual(source.read_text(), "ANSWER = 'agent implementation'\n")
            self.assertIn(
                "hidden-original-answer", git("show", "HEAD:implementation.py")
            )
            self.assertEqual((temp / "setup_patch.diff").read_text(), mask)

    def test_incomplete_mask_fails_before_creating_clean_baseline(self):
        # The isolation phase must reject a mask that was not fully applied.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "testbed"
            repo.mkdir()
            temp = root / "tmp"
            temp.mkdir()
            (temp / "setup_patch.diff").write_text("invalid patch\n")
            script = SANITIZE.replace("/testbed", str(repo)).replace(
                "/tmp/", str(temp) + "/"
            )
            result = subprocess.run(
                ["bash", "-c", script], check=False, capture_output=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((repo / ".git").exists())
