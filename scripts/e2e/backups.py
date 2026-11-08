"""Write the backups file for scripts/e2e/run.mjs.

    python scripts/e2e/backups.py e2e-backups.json [--hickman]

Generates the fictional synthetic backups the end-to-end suites use (corpus/synthetic.json,
with ios-backup-core's backupgen; maren's photos are downloaded from Wikimedia Commons the
first time and cached in ~/.cache/backupgen/media) and, with --hickman, adds the public
pub-hickman-15.3.1 corpus item, which must already be fetched with `python -m corpus.fetch`.
Run it from the repository root with the engine's Python environment.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from corpus.manifest import load_manifest  # noqa: E402
from corpus.synthetic import ensure_generated, load_synthetic  # noqa: E402

# Name in the backups file → synthetic corpus item.
SYNTHETIC = {
    "maren-plain": "syn-maren-ios26-plain",
    "maren-encrypted": "syn-maren-ios26-encrypted",
    "einstein": "syn-einstein-ios26-plain",
    "einstein-encrypted": "syn-einstein-ios17-encrypted",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out", type=Path)
    parser.add_argument("--hickman", action="store_true", help="add pub-hickman-15.3.1 (must be fetched)")
    args = parser.parse_args()

    syn = load_synthetic()
    backups = {}
    for name, key in SYNTHETIC.items():
        folder = ensure_generated(syn[key])
        if folder is None:
            print(f"Couldn't generate {key}: is ios-backup-core (with backupgen) checked out next to this repository?", file=sys.stderr)
            return 1
        backups[name] = {"dir": str(folder), "password": syn[key].password}
    if args.hickman:
        item = load_manifest()["pub-hickman-15.3.1"]
        folder = item.backup_dir()
        if folder is None:
            print("pub-hickman-15.3.1 isn't fetched: python -m corpus.fetch fetch pub-hickman-15.3.1", file=sys.stderr)
            return 1
        backups["hickman"] = {"dir": str(folder), "password": item.password}
    args.out.write_text(json.dumps(backups, indent=2) + "\n", encoding="utf-8")
    for name, b in backups.items():
        print(f"{name}: {b['dir']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
