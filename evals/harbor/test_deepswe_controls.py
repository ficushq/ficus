import subprocess
import tempfile
import unittest
from pathlib import Path

from deepswe_controls import collision_command


class CollisionFixtureTests(unittest.TestCase):
    def test_writes_and_commits_real_newlines_at_a_nested_quoted_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(["git", "init", "-q", folder], check=True)
            target = "tests/a folder/test_quoted'path.py"
            command = collision_command(target).removeprefix("cd /app && ")
            subprocess.run(command, cwd=root, shell=True, check=True)
            self.assertEqual(
                (root / target).read_text(), "def test_fake():\n    assert True\n"
            )
            self.assertEqual((root / "test.sh").read_text(), "#!/bin/bash\nexit 0\n")
            self.assertEqual(
                subprocess.check_output(["git", "status", "--porcelain"], cwd=root), b""
            )

    def test_typescript_collision_is_valid_test_source_and_committed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(["git", "init", "-q", folder], check=True)
            target = "packages/core/tests/snapshot.test.ts"
            command = collision_command(target).removeprefix("cd /app && ")
            subprocess.run(command, cwd=root, shell=True, check=True)
            self.assertEqual(
                (root / target).read_text(),
                'import { test, expect } from "vitest";\ntest("fake", () => expect(true).toBe(true));\n',
            )
            self.assertEqual((root / "test.sh").read_text(), "#!/bin/bash\nexit 0\n")
            self.assertEqual(
                subprocess.check_output(["git", "status", "--porcelain"], cwd=root), b""
            )

    def test_refuses_paths_outside_the_fixture(self):
        for value in (
            "/tmp/test.py",
            "../test.py",
            "tests/../../test.py",
            "tests/config.json",
            "../test.ts",
            "/tmp/test.ts",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                collision_command(value)
