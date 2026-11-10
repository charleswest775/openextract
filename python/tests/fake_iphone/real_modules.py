"""
Make `import pymobiledevice3...` find the real library while a fake iPhone is plugged in.

test_backup.py puts MagicMock stand-ins for pymobiledevice3 into sys.modules when pytest
collects it, and pytest collects every test module before running any test. The fake iPhone
drives the real library, so each scenario swaps the real modules back in for its duration and
puts the stand-ins back afterwards, leaving test_backup.py's tests as they were.
"""

from __future__ import annotations

import contextlib
import importlib
import sys
from types import ModuleType
from typing import Iterator

_PACKAGE = "pymobiledevice3"
_NEEDED = (
    "pymobiledevice3.exceptions",
    "pymobiledevice3.usbmux",
    "pymobiledevice3.lockdown",
    "pymobiledevice3.service_connection",
    "pymobiledevice3.services.device_link",
    "pymobiledevice3.services.mobilebackup2",
    "pymobiledevice3.services.afc",
    "pymobiledevice3.services.notification_proxy",
)
_real: dict[str, ModuleType] = {}


def _ours(name: str) -> bool:
    return name == _PACKAGE or name.startswith(_PACKAGE + ".")


def _is_real(module: object) -> bool:
    # The stand-ins are bare ModuleType objects: no file behind them.
    return getattr(module, "__file__", None) is not None


def _load() -> None:
    if _real:
        return
    saved = {name: module for name, module in sys.modules.items() if _ours(name)}
    stand_ins = {name: module for name, module in saved.items() if not _is_real(module)}
    for name in stand_ins:
        del sys.modules[name]
    try:
        for name in _NEEDED:
            importlib.import_module(name)
        _real.update({name: module for name, module in sys.modules.items() if _ours(name) and _is_real(module)})
    finally:
        sys.modules.update(stand_ins)


def module(name: str) -> ModuleType:
    """A real pymobiledevice3 module, whatever sys.modules holds right now."""
    _load()
    if name not in _real:
        with real_pymobiledevice3():
            importlib.import_module(name)
    return _real[name]


@contextlib.contextmanager
def real_pymobiledevice3() -> Iterator[None]:
    _load()
    previous = {name: sys.modules.get(name) for name in _real}
    sys.modules.update(_real)
    try:
        yield
    finally:
        # Keep any real submodule imported meanwhile, and put the stand-ins back.
        _real.update({name: m for name, m in list(sys.modules.items()) if _ours(name) and _is_real(m)})
        for name, m in previous.items():
            if m is not None and not _is_real(m):
                sys.modules[name] = m
