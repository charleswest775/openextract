"""
Build-time check that the built engine can run every import in the engine's code.

Most of the engine's imports only run when a feature does: pymobiledevice3 when a backup
starts, reportlab when a PDF is saved, pillow_heif when a HEIC photo is converted. So a
PyInstaller engine that starts and opens backups can still fail the first time someone uses
one of them, and no test notices. 0.15.0 shipped like that: pymobiledevice3 11.54 began
loading pyimg4 on its way to a backup, pyimg4 reads its own version from package metadata
that PyInstaller hadn't collected, and every backup failed on every OS (OE-50, OE-51, OE-54).

scripts/bundle-engine.mjs runs ``openextract-engine --self-check <python dir>`` right after
PyInstaller. This reads the engine's source files there, runs each of their imports that isn't
from the standard library, and returns 1 if any fails, which stops the build.

A third-party import that only exists on one OS would fail this check on the others. There
isn't one yet; if one is added, skip it here by name and say why.
"""

import ast
import importlib
import sys
import traceback
from pathlib import Path


def engine_imports(source_dir) -> list:
    """Every import in the engine's files that isn't from the standard library.

    Each is (module, names): ``import a.b`` gives ("a.b", ()) and ``from a.b import c, d``
    gives ("a.b", ("c", "d")). Test files and relative imports are left out.
    """
    found = set()
    for path in sorted(Path(source_dir).glob("*.py")):
        if path.name.startswith("test_"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update((alias.name, ()) for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add((node.module, tuple(sorted(alias.name for alias in node.names))))
    return sorted(item for item in found if item[0].split(".")[0] not in sys.stdlib_module_names)


def _run_import(module: str, names: tuple) -> None:
    """Runs ``import module`` or ``from module import names`` as Python would."""
    loaded = importlib.import_module(module)
    for name in names:
        if name == "*" or hasattr(loaded, name):
            continue
        # A from-import also finds a submodule: ``from reportlab.pdfgen import canvas``.
        try:
            importlib.import_module(f"{module}.{name}")
        except ModuleNotFoundError as e:
            if e.name != f"{module}.{name}":
                raise
            raise ImportError(f"cannot import name {name!r} from {module!r}") from None


def _statement(module: str, names: tuple) -> str:
    return f"from {module} import {', '.join(names)}" if names else f"import {module}"


def run(source_dir) -> int:
    """Runs every import in the engine's files. Returns 0 if they all work, 1 if any fails."""
    imports = engine_imports(source_dir)
    if not imports:
        print(f"Engine self-check: no engine source files in {source_dir!r}", file=sys.stderr)
        return 1
    failed = []
    for module, names in imports:
        try:
            _run_import(module, names)
        except Exception:  # an import can raise anything, e.g. importlib.metadata.PackageNotFoundError
            failed.append(_statement(module, names))
            print(f"\nEngine self-check FAILED: {_statement(module, names)}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
    if failed:
        print(
            f"\nEngine self-check: {len(failed)} of {len(imports)} imports failed in the built engine:\n  "
            + "\n  ".join(failed)
            + "\nA package may need data PyInstaller didn't collect, such as its metadata"
            " (--copy-metadata in scripts/bundle-engine.mjs).",
            file=sys.stderr,
        )
        return 1
    print(f"Engine self-check: all {len(imports)} imports work in the built engine.", file=sys.stderr)
    return 0
