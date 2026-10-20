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


class PandasVerifierTests(unittest.TestCase):
    def test_nested_official_inputs_replace_collisions_without_removing_source(self):
        from verify_featurebench import LAYOUTS, hashes, restore_inputs, verify_inputs

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            official = root / "official"
            (official / "pandas/tests/arrays").mkdir(parents=True)
            (official / "pandas/tests/arrays/test_concat.py").write_text(
                "assert concat() == 42\n"
            )
            for name in LAYOUTS["pandas"][1:]:
                (official / name).write_text("# official\n")
            archive = root / "inputs.tar.gz"
            with tarfile.open(archive, "w:gz") as target:
                # Git archive includes the shared parent directory.
                member = tarfile.TarInfo("pandas")
                member.type = tarfile.DIRTYPE
                target.addfile(member)
                for name in LAYOUTS["pandas"]:
                    target.add(official / name, arcname=name)
            expected = hashes(official, "pandas")
            repo = root / "submission"
            (repo / "pandas/tests").mkdir(parents=True)
            (repo / "pandas/core").mkdir()
            source = repo / "pandas/core/concat.py"
            source.write_text("# agent implementation\n")
            (repo / "pandas/tests/conftest.py").write_text("# override\n")
            (repo / "pandas/conftest.py").write_text("# override\n")
            restore_inputs(repo, archive, expected, "pandas")
            self.assertEqual(source.read_text(), "# agent implementation\n")
            self.assertFalse((repo / "pandas/tests/conftest.py").exists())
            self.assertEqual((repo / "pandas/conftest.py").read_text(), "# official\n")
            (repo / "pandas/tests/arrays/test_concat.py").write_text("assert True\n")
            with self.assertRaisesRegex(ValueError, "hashes"):
                verify_inputs(repo, expected, "pandas")

    def test_nested_parent_symlink_is_rejected_before_mutation(self):
        from verify_featurebench import restore_inputs

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"
            (outside / "tests").mkdir(parents=True)
            keep = outside / "tests/keep.py"
            keep.write_text("original")
            repo = root / "submission"
            repo.mkdir()
            (repo / "pandas").symlink_to(outside)
            archive = root / "inputs.tar.gz"
            with tarfile.open(archive, "w:gz"):
                pass
            with self.assertRaisesRegex(ValueError, "parent symlink"):
                restore_inputs(repo, archive, {}, "pandas")
            self.assertEqual(keep.read_text(), "original")


class FlatVerifierTests(unittest.TestCase):
    def test_all_test_configuration_is_restored_without_replacing_package(self):
        from verify_featurebench import LAYOUTS, hashes, restore_inputs

        for layout in ("sphinx", "seaborn"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                official = root / "official"
                (official / "tests").mkdir(parents=True)
                (official / "tests/test_domain_c.py").write_text(
                    "assert domain() == 42\n"
                )
                for name in LAYOUTS[layout][1:]:
                    (official / name).write_text("# official configuration\n")
                archive = root / "inputs.tar.gz"
                with tarfile.open(archive, "w:gz") as target:
                    for name in LAYOUTS[layout]:
                        target.add(official / name, arcname=name)
                repo = root / "submission"
                (repo / layout / "domains").mkdir(parents=True)
                source = repo / layout / "domains/c.py"
                source.write_text("# candidate implementation\n")
                (repo / LAYOUTS[layout][-1]).write_text("# collect different tests\n")
                restore_inputs(repo, archive, hashes(official, layout), layout)
                self.assertEqual(source.read_text(), "# candidate implementation\n")
                self.assertEqual(
                    (repo / LAYOUTS[layout][-1]).read_text(),
                    "# official configuration\n",
                )


class XarrayVerifierTests(unittest.TestCase):
    def test_root_collection_hook_and_nested_tests_are_both_restored(self):
        from verify_featurebench import LAYOUTS, hashes, restore_inputs

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            official = root / "official"
            (official / "xarray/tests").mkdir(parents=True)
            (official / "xarray/tests/test_backends_chunks.py").write_text(
                "assert chunks() == 42\n"
            )
            for name in LAYOUTS["xarray"][1:]:
                (official / name).write_text("# official\n")
            archive = root / "inputs.tar.gz"
            with tarfile.open(archive, "w:gz") as target:
                for name in LAYOUTS["xarray"]:
                    target.add(official / name, arcname=name)
            repo = root / "submission"
            (repo / "xarray/core").mkdir(parents=True)
            source = repo / "xarray/core/chunks.py"
            source.write_text("# candidate\n")
            (repo / "conftest.py").write_text(
                "def pytest_collection_modifyitems(items): items.clear()\n"
            )
            restore_inputs(repo, archive, hashes(official, "xarray"), "xarray")
            self.assertEqual(source.read_text(), "# candidate\n")
            self.assertEqual((repo / "conftest.py").read_text(), "# official\n")


class XarrayMaskTests(unittest.TestCase):
    def test_recount_checks_implementation_even_when_masked_tests_are_deleted(self):
        from prepare_featurebench import sanitization_script

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "xarray/tests").mkdir(parents=True)
            source = root / "xarray/implementation.py"
            test = root / "xarray/tests/test_feature.py"
            source.write_text("answer = 42\n")
            test.write_text("assert answer == 42\n")

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True)

            git("init", "-q")
            git("config", "user.email", "fixture@localhost")
            git("config", "user.name", "Fixture")
            git("add", "-A")
            git("commit", "-qm", "original")
            source.write_text("raise NotImplementedError\n")
            test.write_text("# masked import\n")
            patch = git("diff")
            # Malformed upstream count is in a test hunk, not implementation.
            prefix, tail = patch.split("diff --git a/xarray/tests/", 1)
            tail = tail.replace("@@ -1 +1 @@", "@@ -1,2 +1,2 @@")
            mask = root / "mask.diff"
            mask.write_text(prefix + "diff --git a/xarray/tests/" + tail)
            test.unlink()
            command = next(
                line
                for line in sanitization_script("xarray").splitlines()
                if line.startswith("git apply")
            )
            command = command.replace("/tmp/setup_patch.diff", str(mask))
            subprocess.run(
                ["bash", "-c", command], cwd=root, check=True, capture_output=True
            )
            source.write_text("answer = 42\n")
            result = subprocess.run(
                ["bash", "-c", command], cwd=root, capture_output=True
            )
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sanitization_script("pandas"), SANITIZE)


class XarrayOracleTests(unittest.TestCase):
    def test_oracle_recreates_only_deleted_test_precondition(self):
        from prepare_featurebench import oracle_test_setup

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "xarray/tests").mkdir(parents=True)
            source = root / "xarray/source.py"
            test = root / "xarray/tests/test_feature.py"
            source.write_text("answer = 42\n")
            test.write_text("from xarray.source import answer\n")

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True)

            git("init", "-q")
            git("config", "user.email", "fixture@localhost")
            git("config", "user.name", "Fixture")
            git("add", "-A")
            git("commit", "-qm", "original")
            source.write_text("raise NotImplementedError\n")
            test.write_text("\n")
            patch = root / "mask.diff"
            patch.write_text(git("diff"))
            test.unlink()
            script = (
                oracle_test_setup("xarray")
                .replace("/testbed", str(root))
                .replace("/tmp/setup_patch.diff", str(patch))
            )
            subprocess.run(["bash", "-ec", script], check=True, capture_output=True)
            self.assertEqual(test.read_text(), "\n")
            self.assertEqual(source.read_text(), "raise NotImplementedError\n")
            git("apply", "--reverse", "--check", str(patch))
        self.assertEqual(oracle_test_setup("sphinx"), "")
