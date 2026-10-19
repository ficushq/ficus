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


class VerifierInputTests(unittest.TestCase):
    def test_colliding_agent_tests_are_replaced_and_source_is_preserved(self):
        import hashlib

        from verify_featurebench import restore_inputs, verify_inputs

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            official = root / "official"
            (official / "tests").mkdir(parents=True)
            (official / "tests/test_feature.py").write_text(
                "assert implementation() == 42\n"
            )
            (official / "pyproject.toml").write_text("[tool.pytest.ini_options]\n")
            (official / "tests/linked").symlink_to("../source-tests")
            expected = {
                str(p.relative_to(official)): (
                    "symlink:" + str(p.readlink())
                    if p.is_symlink()
                    else hashlib.sha256(p.read_bytes()).hexdigest()
                )
                for p in official.rglob("*")
                if p.is_file() or p.is_symlink()
            }
            archive = root / "fixtures.tar.gz"
            with tarfile.open(archive, "w:gz") as target:
                target.add(official / "tests", arcname="tests")
                target.add(official / "pyproject.toml", arcname="pyproject.toml")
            repo = root / "testbed"
            (repo / "tests").mkdir(parents=True)
            (repo / "tests/test_feature.py").write_text("assert True\n")
            (repo / "tests/conftest.py").write_text("# agent collection override\n")
            (repo / "pyproject.toml").write_text("# agent config\n")
            (repo / "implementation.py").write_text("ANSWER = 42\n")
            restore_inputs(repo, archive, expected)
            self.assertEqual(
                (repo / "tests/test_feature.py").read_text(),
                "assert implementation() == 42\n",
            )
            self.assertFalse((repo / "tests/conftest.py").exists())
            self.assertEqual(str((repo / "tests/linked").readlink()), "../source-tests")
            self.assertEqual((repo / "implementation.py").read_text(), "ANSWER = 42\n")
            (repo / "tests/test_feature.py").write_text("assert True\n")
            with self.assertRaisesRegex(ValueError, "hashes"):
                verify_inputs(repo, expected)

    def test_unsafe_fixture_is_rejected_before_submission_changes(self):
        import io

        from verify_featurebench import restore_inputs

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests").mkdir()
            keep = root / "tests/keep.py"
            keep.write_text("original")
            archive = root / "bad.tar.gz"
            with tarfile.open(archive, "w:gz") as target:
                member = tarfile.TarInfo("../outside.py")
                member.size = 1
                target.addfile(member, io.BytesIO(b"x"))
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                restore_inputs(root, archive, {})
            self.assertEqual(keep.read_text(), "original")
