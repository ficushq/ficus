import json
import tempfile
import unittest
from pathlib import Path

from checkpoint import digest, private_json, validate_mounts, verify


class CheckpointIntegrityTests(unittest.TestCase):
    def test_mounts_cannot_silently_drop_workspace_or_session_state(self):
        validate_mounts([{"Destination": "/logs/agent"}, {"Destination": "/tests"}])
        for target in (
            "/app",
            "/opt/ficus-harbor/data",
            "/root",
            "/",
            "/logs-elsewhere",
        ):
            with self.subTest(target=target), self.assertRaises(ValueError):
                validate_mounts([{"Destination": target}])

    def test_private_files_never_overwrite_and_are_owner_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "environment.json"
            private_json(path, {"secret": "fixture"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                private_json(path, {})
            self.assertEqual(json.loads(path.read_text()), {"secret": "fixture"})

    def test_incomplete_corrupt_or_extra_artifacts_cannot_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for name in ("image.tar", "database.dump", "environment.json"):
                (path / name).write_text(name)
            manifest = {
                "version": 1,
                "image_id": "sha256:" + "a" * 64,
                "complete": True,
                "sha256": {f.name: digest(f) for f in path.iterdir()},
            }
            marker = path / "checkpoint.json"
            marker.write_text(json.dumps(manifest))
            self.assertEqual(verify(path), manifest)
            (path / "database.dump").write_text("corrupted")
            with self.assertRaises(ValueError):
                verify(path)
            (path / "database.dump").write_text("database.dump")
            manifest["complete"] = False
            marker.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                verify(path)
            manifest["complete"] = True
            manifest["sha256"]["../../anything"] = "ignored"
            marker.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                verify(path)

    def test_symlink_members_are_not_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            for name in ("image.tar", "database.dump", "environment.json"):
                (path / name).write_text("fixture")
            manifest = {
                "version": 1,
                "image_id": "sha256:" + "a" * 64,
                "complete": True,
                "sha256": {f.name: digest(f) for f in path.iterdir()},
            }
            (path / "checkpoint.json").write_text(json.dumps(manifest))
            (path / "database.dump").unlink()
            (path / "database.dump").symlink_to(path / "image.tar")
            with self.assertRaises(ValueError):
                verify(path)


class CaptureLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, fail_save=False):
        from unittest.mock import patch
        from checkpoint import capture

        calls = []
        image_id = "sha256:" + "a" * 64

        async def fake(*args, **kwargs):
            calls.append(args)
            if args[1:3] == ("inspect", "task"):
                return json.dumps([{"Mounts": [{"Destination": "/logs/agent"}]}])
            if args[1:3] == ("inspect", "ficus-harbor-db-fixture"):
                return json.dumps(
                    [
                        {
                            "Config": {"Labels": {"ficus.harbor": "true"}},
                            "Image": "db-image",
                        }
                    ]
                )
            if args[1:3] == ("image", "inspect"):
                return json.dumps([{"Id": image_id}])
            if args[1] == "commit":
                return "Deprecated flag warning\n" + image_id
            if args[1:3] == ("image", "save") and fail_save:
                raise RuntimeError("Disk full")
            if "output" in kwargs:
                Path(kwargs["output"]).write_bytes(b"fixture")
            return ""

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "checkpoint"
            with patch("checkpoint.command", side_effect=fake):
                if fail_save:
                    with self.assertRaisesRegex(RuntimeError, "Disk full"):
                        await capture(
                            directory, "task", "ficus-harbor-db-fixture", {}, {}
                        )
                    self.assertFalse((directory / "checkpoint.json").exists())
                else:
                    manifest = await capture(
                        directory, "task", "ficus-harbor-db-fixture", {}, {}
                    )
                    self.assertEqual(manifest["image_id"], image_id)
                    self.assertEqual(verify(directory), manifest)
            self.assertIn(("docker", "unpause", "task"), calls)
            self.assertTrue(any(c[1:3] == ("image", "rm") for c in calls))

    async def test_docker_warning_cannot_corrupt_checkpoint_image_identity(self):
        await self.exercise()

    async def test_failed_archive_is_not_complete_and_task_is_unpaused(self):
        await self.exercise(fail_save=True)


class TaskContainerIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_shared_sidecar_hostname_is_not_used_for_checkpoint(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from ficus_agent import main_container_id

        expected = "a" * 64
        env = SimpleNamespace(
            _run_docker_compose_command=AsyncMock(
                return_value=SimpleNamespace(
                    stdout="Compose warning\n" + expected + "\n", return_code=0
                )
            )
        )
        self.assertEqual(await main_container_id(env), expected)
        env._run_docker_compose_command.assert_awaited_once_with(
            ["ps", "-q", "main"], timeout_sec=30
        )
        env._run_docker_compose_command.return_value.stdout = expected + "\n" + "b" * 64
        with self.assertRaises(ValueError):
            await main_container_id(env)
