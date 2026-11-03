"""
The engine must start when Windows refuses to load a native library (#169).

Smart App Control blocks DLLs that aren't signed. pycryptodome, which
iphone_backup_decrypt uses, then raises OSError rather than ImportError while it
is being imported, and that stopped the engine before it could answer anything.
"""

import os
import subprocess
import sys
import textwrap
import unittest

ENGINE_DIR = os.path.join(os.path.dirname(__file__), "..")

# Runs in a fresh interpreter so the blocked library doesn't leak into other tests.
# main.py points sys.stdout at stderr, so the answer goes to the real stdout.
SCRIPT = textwrap.dedent("""
    import sys
    import Crypto.Util._raw_api as raw_api

    def blocked(name, cdecl):
        raise OSError("[WinError 4551] An Application Control policy has blocked this file")

    raw_api.load_lib = blocked
    sys.path.insert(0, sys.argv[1])
    import main  # noqa: F401  (everything the engine imports at startup)
    import backup
    sys.__stdout__.write(f"HAS_DECRYPT={backup.HAS_DECRYPT}\\n")
""")


class TestBlockedNativeLibrary(unittest.TestCase):
    def test_engine_starts_without_decryption_when_pycryptodome_is_blocked(self):
        result = subprocess.run(
            [sys.executable, "-c", SCRIPT, ENGINE_DIR],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("HAS_DECRYPT=False", result.stdout)


if __name__ == "__main__":
    unittest.main()
