"""
The build-time check in python/self_check.py, which scripts/bundle-engine.mjs runs in the
engine PyInstaller has just built, and the error a backup shows when pymobiledevice3 won't load.

Every backup in 0.15.0 failed with "pymobiledevice3 is not installed. Run: pip install
pymobiledevice3": pymobiledevice3 11.54 began importing pyimg4 on its way to a backup, pyimg4
reads its own package metadata, and PyInstaller hadn't collected it (OE-50, OE-51, OE-54).
"""

import importlib
import importlib.metadata
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ENGINE_DIR = HERE.parent
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import device_backup  # noqa: E402
import self_check  # noqa: E402


def test_engine_imports_include_the_ones_only_a_feature_runs():
    imports = self_check.engine_imports(ENGINE_DIR)
    # The import 0.15.0's engine failed on. It only runs when a backup starts.
    assert ("pymobiledevice3.services.mobilebackup2", ("Mobilebackup2Service",)) in imports
    # A from-import of a submodule, when a PDF is saved.
    assert ("reportlab.pdfgen", ("canvas",)) in imports
    modules = {module for module, _ in imports}
    assert not modules & {"os", "json", "asyncio"}  # the standard library is left out
    assert not any(module.split(".")[0] in {"pytest", "fake_iphone"} for module in modules)  # so are tests


@pytest.fixture
def made_up(tmp_path, monkeypatch):
    """A folder for made-up packages, on sys.path, and one for an engine's source files."""
    site = tmp_path / "site"
    source = tmp_path / "engine"
    site.mkdir()
    source.mkdir()
    monkeypatch.syspath_prepend(str(site))
    yield site, source
    for name in [name for name in sys.modules if name.startswith("oe_selfcheck_")]:
        del sys.modules[name]


def _package(site: Path, name: str, init: str, **modules: str) -> None:
    (site / name).mkdir()
    (site / name / "__init__.py").write_text(init, encoding="utf-8")
    for module, text in modules.items():
        (site / name / f"{module}.py").write_text(text, encoding="utf-8")
    importlib.invalidate_caches()


def test_passes_when_every_import_works(made_up, capsys):
    site, source = made_up
    _package(site, "oe_selfcheck_ok", "VALUE = 1\n", sub="")
    (source / "feature.py").write_text(
        "import os\n"
        "def use():\n"
        "    from oe_selfcheck_ok import VALUE, sub\n"
        "    import oe_selfcheck_ok.sub\n",
        encoding="utf-8",
    )
    assert self_check.run(source) == 0
    assert "all 2 imports work" in capsys.readouterr().err


def test_fails_when_a_package_cant_read_its_own_metadata(made_up, capsys):
    # What pyimg4 and apple_compress do when they're imported.
    site, source = made_up
    _package(site, "oe_selfcheck_meta", "from importlib.metadata import version\n__version__ = version(__package__)\n")
    (source / "feature.py").write_text("def use():\n    from oe_selfcheck_meta import __version__\n", encoding="utf-8")
    assert self_check.run(source) == 1
    err = capsys.readouterr().err
    assert "No package metadata was found for oe_selfcheck_meta" in err
    assert "1 of 1 imports failed" in err
    assert "from oe_selfcheck_meta import __version__" in err


def test_fails_when_a_name_has_gone(made_up, capsys):
    # A package that renamed something the engine imports.
    site, source = made_up
    _package(site, "oe_selfcheck_api", "OLD_NAME = 1\n")
    (source / "feature.py").write_text("def use():\n    from oe_selfcheck_api import NEW_NAME\n", encoding="utf-8")
    assert self_check.run(source) == 1
    assert "cannot import name 'NEW_NAME' from 'oe_selfcheck_api'" in capsys.readouterr().err


def test_fails_without_source_files(tmp_path):
    assert self_check.run(tmp_path) == 1


def test_main_runs_the_check_and_exits_without_serving(tmp_path):
    (tmp_path / "feature.py").write_text("def use():\n    import oe_selfcheck_not_there\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(ENGINE_DIR / "main.py"), "--self-check", str(tmp_path)],
        capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL,
    )
    assert result.returncode == 1, result.stderr
    assert "import oe_selfcheck_not_there" in result.stderr
    assert result.stdout == ""  # no {"status":"ready"}: the JSON-RPC loop never started


@pytest.mark.parametrize("error", [
    importlib.metadata.PackageNotFoundError("pyimg4"),  # 0.15.0
    ImportError("cannot import name 'Mobilebackup2Service'", name="pymobiledevice3.services.mobilebackup2"),
])
def test_a_broken_install_isnt_called_missing(error):
    assert str(device_backup._device_code_import_error(error)) == device_backup._DEVICE_CODE_DID_NOT_LOAD


def test_pip_hint_only_where_pip_can_help(monkeypatch):
    missing = ModuleNotFoundError("No module named 'pymobiledevice3'", name="pymobiledevice3")
    assert "pip install pymobiledevice3" in str(device_backup._device_code_import_error(missing))
    monkeypatch.setattr(sys, "frozen", True, raising=False)  # the built app
    assert str(device_backup._device_code_import_error(missing)) == device_backup._DEVICE_CODE_DID_NOT_LOAD


def test_start_backup_says_the_part_didnt_load(monkeypatch, tmp_path):
    # None in sys.modules makes the import fail, as a module that can't load would.
    monkeypatch.setitem(sys.modules, "pymobiledevice3.services.mobilebackup2", None)
    with pytest.raises(RuntimeError) as raised:
        device_backup.DeviceBackupManager().start_backup(
            "00008150-0000000000000000", str(tmp_path), False, None, lambda *a, **k: None,
        )
    assert str(raised.value) == device_backup._DEVICE_CODE_DID_NOT_LOAD
    assert isinstance(raised.value.__cause__, ImportError)
