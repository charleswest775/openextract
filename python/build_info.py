"""
What this engine is: the app version, and the ios-backup-core commit it reads backups with.

ping reports the version, and a data bundle's manifest.json names both, so a file made
from a backup says which code made it. Nothing here touches the network.

Where they come from:

- The built engine (PyInstaller): ``build_info.json`` beside its code, which
  scripts/bundle-engine.mjs writes before it builds (``python build_info.py --write``)
  from package.json and the ios-backup-core checkout it builds with.
- Running from source (development, tests): package.json two folders up, and the
  git checkout ios-backup-core is imported from, read as files (no git command).

Either can be missing (a copy of the code without .git, say); then it's None.
"""

import json
import os
import sys
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
FILE_NAME = "build_info.json"


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _built() -> dict:
    """build_info.json, in a built engine only: from source it could be a stale leftover."""
    if not getattr(sys, "frozen", False):
        return {}
    return _read_json(os.path.join(getattr(sys, "_MEIPASS", HERE), FILE_NAME))


def _package_json_version() -> Optional[str]:
    version = _read_json(os.path.join(HERE, "..", "package.json")).get("version")
    return version if isinstance(version, str) and version else None


def app_version() -> Optional[str]:
    """OpenExtract's version, e.g. "0.17.0"."""
    return _built().get("app_version") or _package_json_version()


def _git_dir(start: str) -> Optional[str]:
    """The .git folder of the checkout holding ``start``, following a worktree's .git file."""
    folder = os.path.abspath(start)
    while True:
        dot_git = os.path.join(folder, ".git")
        if os.path.isdir(dot_git):
            return dot_git
        if os.path.isfile(dot_git):
            try:
                with open(dot_git, encoding="utf-8") as f:
                    line = f.read().strip()
            except OSError:
                return None
            if line.startswith("gitdir:"):
                path = line[len("gitdir:"):].strip()
                return path if os.path.isabs(path) else os.path.normpath(os.path.join(folder, path))
            return None
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent


def _is_sha(value: str) -> bool:
    return len(value) == 40 and all(c in "0123456789abcdef" for c in value)


def git_commit(start: str) -> Optional[str]:
    """The commit checked out in the git checkout holding ``start``, or None."""
    git_dir = _git_dir(start)
    if not git_dir:
        return None
    try:
        with open(os.path.join(git_dir, "HEAD"), encoding="utf-8") as f:
            head = f.read().strip()
    except OSError:
        return None
    if _is_sha(head):  # detached, as CI and the release check it out
        return head
    if not head.startswith("ref:"):
        return None
    ref = head[len("ref:"):].strip()
    # A worktree keeps its branches in the main checkout's folder ("commondir")
    common = git_dir
    try:
        with open(os.path.join(git_dir, "commondir"), encoding="utf-8") as f:
            common = os.path.normpath(os.path.join(git_dir, f.read().strip()))
    except OSError:
        pass
    for folder in (git_dir, common):
        try:
            with open(os.path.join(folder, *ref.split("/")), encoding="utf-8") as f:
                sha = f.read().strip()
            if _is_sha(sha):
                return sha
        except OSError:
            pass
    try:
        with open(os.path.join(common, "packed-refs"), encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split(" ")
                if len(parts) == 2 and parts[1] == ref and _is_sha(parts[0]):
                    return parts[0]
    except OSError:
        pass
    return None


def ios_backup_core_commit() -> Optional[str]:
    """The ios-backup-core commit backups are read with, or None when it can't be told."""
    built = _built().get("ios_backup_core_commit")
    if built:
        return built
    try:
        import ios_backup_core
    except Exception:  # noqa: BLE001  ios-backup-core missing: the engine says so elsewhere
        return None
    return git_commit(os.path.dirname(os.path.abspath(ios_backup_core.__file__)))


def write(path: str = os.path.join(HERE, FILE_NAME)) -> dict:
    """Write build_info.json for scripts/bundle-engine.mjs, and return what it holds."""
    info = {"app_version": _package_json_version(), "ios_backup_core_commit": ios_backup_core_commit()}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)
        f.write("\n")
    return info


if __name__ == "__main__":
    if "--write" in sys.argv:
        print(json.dumps(write()))
    else:
        print(json.dumps({"app_version": app_version(), "ios_backup_core_commit": ios_backup_core_commit()}))
