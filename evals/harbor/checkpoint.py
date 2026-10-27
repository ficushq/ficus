"""Private Docker + Postgres recovery evidence for isolated Harbor trials.

No provider calls, automatic retries, or production instance access. Restore is
an offline operation; resuming inference requires a separately guarded launcher.
"""

import asyncio
import hashlib
import json
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit


async def command(*args, output=None, input_file=None, timeout=600):
    with open(input_file, "rb") if input_file else open(os.devnull, "rb") as source:
        sink = None
        try:
            if output is not None:
                sink = os.fdopen(
                    os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
                )
            child = await asyncio.create_subprocess_exec(
                *args,
                stdin=source,
                stdout=sink or asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(child.communicate(), timeout)
            except BaseException:
                if child.returncode is None:
                    child.kill()
                await child.wait()
                raise
            if child.returncode:
                # Do not echo arguments: env arguments can contain local credentials.
                raise RuntimeError(
                    f"{args[0]} {args[1]} failed ({child.returncode}): {stderr.decode()[-1500:]}"
                )
            return (stdout or b"").decode().strip()
        finally:
            if sink:
                sink.close()


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def private_json(path, value):
    with os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def validate_mounts(mounts):
    # Docker commit omits mount contents. Only Harbor's separate log/test mounts
    # may be omitted; reject workspace, home, runtime and arbitrary bind mounts.
    for mount in mounts:
        target = mount["Destination"].rstrip("/")
        if not any(
            target == allowed or target.startswith(allowed + "/")
            for allowed in ("/logs", "/tests")
        ):
            raise ValueError(f"Checkpoint cannot omit mounted state at {target}")


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "checkpoint.json").read_text())
    if manifest.get("version") != 1 or manifest.get("complete") is not True:
        raise ValueError("Incomplete or unsupported checkpoint")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest.get("image_id", "")):
        raise ValueError("Invalid checkpoint image identity")
    if set(manifest["sha256"]) != {"image.tar", "database.dump", "environment.json"}:
        raise ValueError("Unexpected checkpoint members")
    for name, expected in manifest["sha256"].items():
        path = directory / name
        if path.is_symlink() or digest(path) != expected:
            raise ValueError(f"Checkpoint checksum mismatch: {name}")
    return manifest


async def capture(directory, container, database, env, metadata):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    inspected = json.loads(await command("docker", "inspect", container))[0]
    db = json.loads(await command("docker", "inspect", database))[0]
    validate_mounts(inspected["Mounts"])
    await command(
        "docker", "exec", container, "test", "-x", "/opt/ficus-harbor/bin/bun"
    )
    if (db["Config"]["Labels"] or {}).get("ficus.harbor") != "true":
        raise ValueError("Refusing to checkpoint a non-Harbor database")
    if not database.startswith("ficus-harbor-db-"):
        raise ValueError("Expected a disposable Harbor database")
    image = "ficus-harbor-checkpoint:" + secrets.token_hex(12)
    paused = False
    image_created = False
    try:
        # Freeze ALL task processes, including any descendants left outside the
        # API/worker process groups, while taking the matching DB/files snapshot.
        await command("docker", "pause", container)
        paused = True
        await command(
            "docker",
            "exec",
            database,
            "pg_dump",
            "-U",
            "postgres",
            "-d",
            "ficus_harbor",
            "-Fc",
            output=directory / "database.dump",
        )
        await command("docker", "commit", "--pause=false", container, image)
        image_created = True
        image_id = json.loads(await command("docker", "image", "inspect", image))[0][
            "Id"
        ]
        await command("docker", "image", "save", image, output=directory / "image.tar")
        private_json(directory / "environment.json", env)
        manifest = {
            "version": 1,
            "complete": True,
            "image_id": image_id,
            "image_tag": image,
            "database_image_id": db["Image"],
            "excluded_mounts": [m["Destination"] for m in inspected["Mounts"]],
            "metadata": metadata,
            "sha256": {
                name: digest(directory / name)
                for name in ("image.tar", "database.dump", "environment.json")
            },
        }
        # This final file is the completion marker; partial captures cannot restore.
        private_json(directory / "checkpoint.json", manifest)
        verify(directory)
        return manifest
    finally:
        if paused:
            await command("docker", "unpause", container)
        if image_created:
            await command("docker", "image", "rm", image)


class OfflineRestore:
    """Own only fresh no-network containers, and never start API/worker processes."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.manifest = verify(directory)
        suffix = secrets.token_hex(12)
        self.container = "ficus-harbor-restore-" + suffix
        self.database = "ficus-harbor-db-" + suffix
        self.env = json.loads((self.directory / "environment.json").read_text())
        self.env["DATABASE_URL"] = (
            f"postgres://postgres:{secrets.token_hex(24)}"
            f"@{self.database}:5432/ficus_harbor"
        )
        self.created = []
        self.loaded = False

    async def __aenter__(self):
        try:
            try:
                await command("docker", "image", "inspect", self.manifest["image_id"])
                present = True
            except RuntimeError:
                present = False
            await command(
                "docker", "image", "load", "--input", str(self.directory / "image.tar")
            )
            self.loaded = not present
            # Explicit entrypoint prevents inherited app startup or model calls.
            await command(
                "docker",
                "run",
                "-d",
                "--name",
                self.container,
                "--network",
                "none",
                "--cpus",
                "2",
                "--memory",
                "8g",
                "--entrypoint",
                "/bin/sh",
                self.manifest["image_id"],
                "-c",
                "exec sleep infinity",
            )
            self.created.append(self.container)
            await command(
                "docker",
                "run",
                "-d",
                "--name",
                self.database,
                "--network",
                "container:" + self.container,
                "--cpus",
                "0.5",
                "--memory",
                "512m",
                "--label",
                "ficus.harbor=true",
                "--tmpfs",
                "/var/lib/postgresql/data",
                "-e",
                "POSTGRES_DB=ficus_harbor",
                "-e",
                "POSTGRES_PASSWORD=" + urlsplit(self.env["DATABASE_URL"]).password,
                self.manifest["database_image_id"],
            )
            self.created.append(self.database)
            for attempt in range(60):
                try:
                    await command(
                        "docker",
                        "exec",
                        self.database,
                        "pg_isready",
                        "-U",
                        "postgres",
                        "-d",
                        "ficus_harbor",
                    )
                    break
                except RuntimeError:
                    if attempt == 59:
                        raise
                    await asyncio.sleep(1)
            await command(
                "docker",
                "exec",
                "-i",
                self.database,
                "pg_restore",
                "--exit-on-error",
                "--no-owner",
                "-U",
                "postgres",
                "-d",
                "ficus_harbor",
                input_file=self.directory / "database.dump",
            )
            await command(
                "docker",
                "exec",
                self.container,
                "/bin/sh",
                "-c",
                f'echo "127.0.0.1 {self.database}" >> /etc/hosts',
            )
            return self
        except BaseException:
            await self.__aexit__(None, None, None)
            raise

    async def __aexit__(self, *_):
        for name in reversed(self.created):
            await command("docker", "rm", "-f", "-v", name)
        self.created.clear()
        if self.loaded:
            await command("docker", "image", "rm", self.manifest["image_tag"])
            self.loaded = False
