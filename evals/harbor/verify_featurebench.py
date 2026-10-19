"""Restore and audit immutable Pydantic verifier inputs after agent execution.

Uploaded with /tests only after inference. The upstream grader remains unchanged.
This deliberately supports only the audited Pydantic tests/ + pyproject.toml layout.
"""

import argparse
import hashlib
import json
import posixpath
import shutil
import tarfile
from pathlib import Path, PurePosixPath


def hashes(root):
    paths = [root / "pyproject.toml", *(root / "tests").rglob("*")]
    return {
        str(path.relative_to(root)): (
            "symlink:" + str(path.readlink())
            if path.is_symlink()
            else hashlib.sha256(path.read_bytes()).hexdigest()
        )
        for path in sorted(paths)
        if (path.is_file() or path.is_symlink())
        and "__pycache__" not in path.parts
        and path.suffix != ".pyc"
    }


def restore_inputs(root, archive_path, expected):
    # Reject unsafe fixture members before touching the disposable submission.
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] not in {"tests", "pyproject.toml"}
                or not (member.isdir() or member.isfile() or member.issym())
            ):
                raise ValueError("Unsafe verifier fixture member")
            if member.issym():
                target = posixpath.normpath(str(path.parent / member.linkname))
                if (
                    PurePosixPath(member.linkname).is_absolute()
                    or target == ".."
                    or target.startswith("../")
                ):
                    raise ValueError("Unsafe verifier fixture symlink")
            if any(
                parent in {m.name for m in members if m.issym()}
                for parent in map(str, path.parents)
            ):
                raise ValueError("Fixture member nested below a symlink")
        tests = root / "tests"
        if tests.is_symlink():
            tests.unlink()
        elif tests.exists():
            shutil.rmtree(tests)
        config = root / "pyproject.toml"
        if config.is_symlink() or config.is_file():
            config.unlink()
        elif config.exists():
            raise ValueError("Unexpected directory at verifier config")
        for member in members:
            target = root / member.name
            if member.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
            elif member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source:
                    target.write_bytes(source.read())
    verify_inputs(root, expected)


def verify_inputs(root, expected):
    actual = hashes(root)
    if actual != expected:
        raise ValueError("Official verifier input hashes do not match")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("restore", "check"))
    parser.add_argument("--root", type=Path, default=Path("/testbed"))
    parser.add_argument(
        "--fixtures", type=Path, default=Path(__file__).parent / "fixtures"
    )
    args = parser.parse_args()
    expected = json.loads((args.fixtures / "verifier-inputs.json").read_text())
    if args.mode == "restore":
        restore_inputs(args.root, args.fixtures / "verifier-inputs.tar.gz", expected)
    else:
        verify_inputs(args.root, expected)
    print("Official verifier inputs verified")


if __name__ == "__main__":
    main()
