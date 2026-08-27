#!/usr/bin/env python3
"""Safe source extraction and path-free Python console inventory."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import site
import stat
import sys
import sysconfig
import tarfile
from urllib.parse import urlparse
from urllib.request import url2pathname
import zipfile


CHUNK_BYTES = 1024 * 1024
MAX_ARCHIVE_FILES = 100_000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_BYTES):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def normalized_file_sha256(path: Path, roots: list[Path]) -> str:
    values: set[str] = set()
    for root in roots:
        values.add(str(root))
        values.add(str(root).replace("\\", "/"))
        values.add(str(root).replace("\\", "\\\\"))
    replacements: dict[bytes, bytes] = {}
    for value in values:
        replacements[value.encode("utf-8")] = b"<attested-root>"
        replacements[value.encode("utf-16-le")] = "<attested-root>".encode("utf-16-le")
    patterns = sorted(replacements, key=len, reverse=True)
    matcher = re.compile(b"|".join(re.escape(pattern) for pattern in patterns))
    overlap = max(map(len, patterns)) - 1
    digest = hashlib.sha256()
    pending = b""
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_BYTES):
            pending += chunk
            safe_start_limit = max(0, len(pending) - overlap)
            position = 0
            while position < safe_start_limit:
                match = matcher.search(pending, position)
                if match is None or match.start() >= safe_start_limit:
                    digest.update(pending[position:safe_start_limit])
                    position = safe_start_limit
                    break
                digest.update(pending[position : match.start()])
                digest.update(replacements[match.group(0)])
                position = match.end()
            pending = pending[position:]
    position = 0
    for match in matcher.finditer(pending):
        digest.update(pending[position : match.start()])
        digest.update(replacements[match.group(0)])
        position = match.end()
    digest.update(pending[position:])
    return f"sha256:{digest.hexdigest()}"


def safe_member(name: str) -> PurePosixPath:
    if (
        not name
        or name.startswith(("/", "-", "@"))
        or "\\" in name
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        raise ValueError(f"unsafe archive path: {name!r}")
    path = PurePosixPath(name)
    if any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"unsafe archive path: {name!r}")
    return path


def relative_member(name: str, archive_root: str) -> PurePosixPath | None:
    path = safe_member(name.rstrip("/"))
    if archive_root == ".":
        return path
    root = safe_member(archive_root)
    if path == root:
        return None
    if path.parts[: len(root.parts)] != root.parts:
        raise ValueError(f"archive member is outside reviewed root {archive_root}: {name}")
    relative = PurePosixPath(*path.parts[len(root.parts) :])
    return relative if relative.parts else None


def destination_path(destination: Path, relative: PurePosixPath) -> Path:
    output = destination.joinpath(*relative.parts)
    try:
        output.resolve().relative_to(destination.resolve())
    except ValueError as error:
        raise ValueError(f"archive member escapes destination: {relative}") from error
    return output


def copy_bounded(source, output: Path, declared_size: int, remaining: int) -> int:
    if declared_size < 0 or declared_size > remaining:
        raise ValueError("source archive exceeds its extracted-byte limit")
    output.parent.mkdir(parents=True, exist_ok=True)
    copied = 0
    with output.open("xb") as target:
        while chunk := source.read(CHUNK_BYTES):
            copied += len(chunk)
            if copied > declared_size or copied > remaining:
                raise ValueError("source archive file exceeded its declared or configured size")
            target.write(chunk)
    if copied != declared_size:
        raise ValueError("source archive file size differs from its header")
    return copied


def extract_tar(archive: Path, destination: Path, archive_root: str, max_bytes: int) -> tuple[int, int]:
    total = 0
    files = 0
    seen: set[str] = set()
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            relative = relative_member(member.name, archive_root)
            if relative is None:
                continue
            key = relative.as_posix()
            if key in seen:
                raise ValueError(f"duplicate archive member: {key}")
            seen.add(key)
            output = destination_path(destination, relative)
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isreg():
                raise ValueError(f"source archive contains a non-regular member: {member.name}")
            files += 1
            if files > MAX_ARCHIVE_FILES:
                raise ValueError("source archive has too many files")
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError(f"cannot read archive member: {member.name}")
            with stream:
                total += copy_bounded(stream, output, member.size, max_bytes - total)
            output.chmod(member.mode & 0o777)
    return files, total


def extract_zip(archive: Path, destination: Path, archive_root: str, max_bytes: int) -> tuple[int, int]:
    total = 0
    files = 0
    seen: set[str] = set()
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            relative = relative_member(member.filename, archive_root)
            if relative is None:
                continue
            key = relative.as_posix()
            if key in seen:
                raise ValueError(f"duplicate archive member: {key}")
            seen.add(key)
            output = destination_path(destination, relative)
            unix_mode = member.external_attr >> 16
            member_kind = stat.S_IFMT(unix_mode)
            if member.is_dir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            if member.flag_bits & 0x1:
                raise ValueError(f"source archive contains an encrypted member: {member.filename}")
            if member_kind not in (0, stat.S_IFREG):
                raise ValueError(f"source archive contains a non-regular member: {member.filename}")
            files += 1
            if files > MAX_ARCHIVE_FILES:
                raise ValueError("source archive has too many files")
            with source.open(member) as stream:
                total += copy_bounded(stream, output, member.file_size, max_bytes - total)
            if unix_mode:
                output.chmod(unix_mode & 0o777)
    return files, total


def extract_source(arguments: argparse.Namespace) -> None:
    archive = Path(arguments.archive).resolve()
    destination = Path(arguments.destination).resolve()
    if destination.exists():
        raise ValueError(f"extraction destination already exists: {destination}")
    destination.mkdir(parents=True)
    try:
        if arguments.format == "tar.gz":
            files, total = extract_tar(
                archive, destination, arguments.archive_root, arguments.max_extracted_bytes
            )
        else:
            files, total = extract_zip(
                archive, destination, arguments.archive_root, arguments.max_extracted_bytes
            )
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    print(json.dumps({"schemaVersion": 1, "files": files, "bytes": total}, sort_keys=True))


def normalized_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def path_is_within(path: Path, roots: list[Path]) -> tuple[Path, Path] | None:
    for root in roots:
        try:
            return root, path.relative_to(root)
        except ValueError:
            continue
    return None


def stable_distribution_files(
    distribution, site_roots: list[Path], normalized_roots: list[Path]
) -> tuple[int, str]:
    entries: list[tuple[str, str]] = []
    files = distribution.files
    if files is None:
        raise ValueError(f"distribution {distribution.metadata['Name']} has no installed-file inventory")
    for package_path in files:
        located = Path(distribution.locate_file(package_path)).resolve()
        within = path_is_within(located, site_roots)
        if within is None:
            continue
        _, relative = within
        parts = relative.parts
        if "__pycache__" in parts or relative.suffix in (".pyc", ".pyo"):
            continue
        if relative.name in ("RECORD", "direct_url.json", "uv_cache.json") and any(
            part.endswith(".dist-info") for part in parts
        ):
            continue
        if not located.is_file():
            raise ValueError(f"installed distribution file is missing: {relative.as_posix()}")
        entries.append((relative.as_posix(), normalized_file_sha256(located, normalized_roots)))
    if not entries:
        raise ValueError(f"distribution {distribution.metadata['Name']} has no stable installed files")
    digest = hashlib.sha256(b"sha256-python-distribution-files-v1\0")
    for path, file_digest in sorted(entries):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\0")
    return len(entries), f"sha256:{digest.hexdigest()}"


def runtime_stdlib_digest() -> tuple[int, str]:
    stdlib = Path(sysconfig.get_path("stdlib")).resolve()
    entries: list[tuple[str, int, str]] = []
    for path in stdlib.rglob("*"):
        relative = path.relative_to(stdlib)
        if any(part in ("site-packages", "dist-packages", "__pycache__") for part in relative.parts):
            continue
        if path.suffix in (".pyc", ".pyo") or not path.is_file():
            continue
        entries.append((relative.as_posix(), path.stat().st_size, sha256_file(path)))
    digest = hashlib.sha256(b"sha256-python-stdlib-v1\0")
    for path, size, file_digest in sorted(entries):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\0")
    return len(entries), f"sha256:{digest.hexdigest()}"


def console_launcher(console: str, prefix: Path) -> str:
    scripts = Path(sysconfig.get_path("scripts")).resolve()
    names = [f"{console}.exe", f"{console}.cmd", console] if os.name == "nt" else [console]
    launcher = next((scripts / name for name in names if (scripts / name).is_file()), None)
    if launcher is None:
        raise ValueError(f"installed console launcher is missing: {console}")
    try:
        relative = launcher.relative_to(prefix)
    except ValueError as error:
        raise ValueError("installed console launcher is outside the environment") from error
    return relative.as_posix()


def inventory_console(arguments: argparse.Namespace) -> None:
    prefix = Path(sys.prefix).resolve()
    source_root = Path(arguments.source_root).resolve()
    if not source_root.is_dir():
        raise ValueError("installed console source root is missing")
    site_roots = [Path(path).resolve() for path in site.getsitepackages()]
    if not site_roots or any(path_is_within(root, [prefix]) is None for root in site_roots):
        raise ValueError("Python environment site-packages is outside sys.prefix")

    distributions = []
    seen_names: set[str] = set()
    selected = None
    for distribution in importlib.metadata.distributions():
        metadata_name = distribution.metadata.get("Name")
        if not metadata_name:
            raise ValueError("installed distribution has no Name metadata")
        name = normalized_name(metadata_name)
        if name in seen_names:
            raise ValueError(f"Python environment repeats distribution {name}")
        seen_names.add(name)
        file_count, files_sha256 = stable_distribution_files(distribution, site_roots, [prefix, source_root])
        entry = {
            "name": name,
            "version": distribution.version,
            "fileCount": file_count,
            "filesSha256": files_sha256,
        }
        distributions.append(entry)
        if name == normalized_name(arguments.distribution):
            selected = distribution
    if selected is None:
        raise ValueError(f"installed distribution is missing: {arguments.distribution}")

    direct_url_text = selected.read_text("direct_url.json")
    if not direct_url_text:
        raise ValueError("installed project distribution has no direct_url.json")
    direct_url = json.loads(direct_url_text)
    editable = direct_url.get("dir_info", {}).get("editable") is True
    if editable != arguments.editable:
        raise ValueError("installed project mode differs from the reviewed editable policy")
    parsed_source = urlparse(direct_url.get("url", ""))
    if parsed_source.scheme != "file" or parsed_source.netloc not in ("", "localhost"):
        raise ValueError("installed project does not have a local source binding")
    installed_source = Path(url2pathname(parsed_source.path)).resolve()
    if installed_source != source_root:
        raise ValueError("installed project is not bound to the attested source tree")

    entry_points = [
        entry
        for entry in selected.entry_points
        if entry.group == "console_scripts" and entry.name == arguments.console
    ]
    if len(entry_points) != 1:
        raise ValueError(f"distribution must expose exactly one {arguments.console} console script")
    launcher = console_launcher(arguments.console, prefix)
    binding = {
        "distribution": normalized_name(arguments.distribution),
        "distributionVersion": selected.version,
        "script": arguments.console,
        "entryPoint": entry_points[0].value,
        "launcher": launcher,
    }
    binding_bytes = json.dumps(binding, sort_keys=True, separators=(",", ":")).encode("utf-8")
    binding_sha256 = hashlib.sha256(b"sha256-console-binding-v1\0" + binding_bytes).hexdigest()
    stdlib_files, stdlib_sha256 = runtime_stdlib_digest()
    distributions.sort(key=lambda entry: (entry["name"], entry["version"], entry["filesSha256"]))
    environment_bytes = json.dumps(distributions, sort_keys=True, separators=(",", ":")).encode("utf-8")
    result = {
        "schemaVersion": 1,
        "runtime": {
            "implementation": sys.implementation.name,
            "pythonVersion": platform.python_version(),
            "cacheTag": sys.implementation.cache_tag,
            "executableSha256": sha256_file(Path(sys.executable).resolve()),
            "stdlibFileCount": stdlib_files,
            "stdlibSha256": stdlib_sha256,
        },
        "environment": {
            "digestAlgorithm": "sha256-python-installed-files-v1",
            "pathNormalization": ["python-environment", "source-root"],
            "excludedInstallMetadata": ["RECORD", "direct_url.json", "uv_cache.json"],
            "excludedGeneratedLaunchers": True,
            "distributionCount": len(distributions),
            "sha256": f"sha256:{hashlib.sha256(environment_bytes).hexdigest()}",
            "distributions": distributions,
        },
        "console": {
            "distribution": normalized_name(arguments.distribution),
            "distributionVersion": selected.version,
            "installMode": "editable" if editable else "non-editable",
            "script": arguments.console,
            "entryPoint": entry_points[0].value,
            "sourceBinding": "direct-url",
            "launcher": launcher,
            "bindingDigestAlgorithm": "sha256-console-binding-v1",
            "bindingSha256": f"sha256:{binding_sha256}",
        },
    }
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    extract = commands.add_parser("extract")
    extract.add_argument("--archive", required=True)
    extract.add_argument("--format", choices=("tar.gz", "zip"), required=True)
    extract.add_argument("--archive-root", required=True)
    extract.add_argument("--destination", required=True)
    extract.add_argument("--max-extracted-bytes", type=int, required=True)
    inventory = commands.add_parser("inventory")
    inventory.add_argument("--distribution", required=True)
    inventory.add_argument("--console", required=True)
    inventory.add_argument("--source-root", required=True)
    inventory.add_argument("--editable", action="store_true")
    return root


def main() -> None:
    arguments = parser().parse_args()
    if arguments.command == "extract":
        extract_source(arguments)
    else:
        inventory_console(arguments)


if __name__ == "__main__":
    main()
