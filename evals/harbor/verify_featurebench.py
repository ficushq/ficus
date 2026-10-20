"""Restore and audit immutable FeatureBench verifier inputs after agent execution.

Uploaded with /tests only after inference. The upstream grader remains unchanged.
Only the explicitly audited repository layouts below are supported.
"""

import argparse
import hashlib
import json
import posixpath
import shutil
import tarfile
from pathlib import Path, PurePosixPath


LAYOUTS = {
    "pydantic": ("tests", "pyproject.toml"),
    "sphinx": ("tests", "pyproject.toml", "tox.ini"),
    "xarray": ("xarray/tests", "conftest.py", "pyproject.toml", "setup.py"),
    "pandas": (
        "pandas/tests",
        "pandas/conftest.py",
        "pyproject.toml",
        "requirements-dev.txt",
    ),
}


def hashes(root, layout="pydantic"):
    paths = []
    for relative in LAYOUTS[layout]:
        path = root / relative
        paths.append(path)
        if path.is_dir() and not path.is_symlink():
            paths.extend(path.rglob("*"))
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


def restore_inputs(root, archive_path, expected, layout="pydantic"):
    # Reject unsafe fixture members before touching the disposable submission.
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or not any(
                    path == PurePosixPath(p)
                    or PurePosixPath(p) in path.parents
                    or (member.isdir() and path in PurePosixPath(p).parents)
                    for p in LAYOUTS[layout]
                )
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
        for relative in LAYOUTS[layout]:
            target = root / relative
            for parent in target.parents:
                if parent == root:
                    break
                if parent.is_symlink():
                    raise ValueError("Unsafe verifier parent symlink")
        for relative in LAYOUTS[layout]:
            target = root / relative
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
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
    verify_inputs(root, expected, layout)


def verify_inputs(root, expected, layout="pydantic"):
    actual = hashes(root, layout)
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
    layout_path = args.fixtures / "verifier-layout.json"
    layout = (
        json.loads(layout_path.read_text())["layout"]
        if layout_path.exists()
        else "pydantic"
    )
    if layout not in LAYOUTS:
        raise ValueError("Unsupported verifier layout")
    if args.mode == "restore":
        restore_inputs(
            args.root, args.fixtures / "verifier-inputs.tar.gz", expected, layout
        )
    else:
        verify_inputs(args.root, expected, layout)
    print("Official verifier inputs verified")


if __name__ == "__main__":
    main()
