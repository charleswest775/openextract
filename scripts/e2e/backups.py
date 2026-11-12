"""Write the backups file for scripts/e2e/run.mjs.

    python scripts/e2e/backups.py e2e-backups.json [--hickman]

Generates the fictional synthetic backups the end-to-end suites use (corpus/synthetic.json,
with ios-backup-core's backupgen; maren's photos are downloaded from Wikimedia Commons the
first time and cached in ~/.cache/backupgen/media) and, with --hickman, adds the public
pub-hickman-15.3.1 corpus item, which must already be fetched with `python -m corpus.fetch`.
It also writes "podcasts": a copy of einstein with a fictional Apple Podcasts library
(python/tests/podcasts_backup.py), next to the backups file in e2e-podcasts/.
Run it from the repository root with the engine's Python environment.
"""

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "python" / "tests"))

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
    backups["podcasts"] = {"dir": str(_podcasts_backup(Path(backups["einstein"]["dir"]), args.out.resolve().parent)), "password": None}
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


def _podcasts_backup(einstein: Path, parent: Path) -> Path:
    """Einstein's backup plus the fictional Podcasts library the screenshots use."""
    import podcasts_backup as pb

    target = parent / "e2e-podcasts" / pb.DEMO_UDID
    shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="podcasts-e2e-") as parts:
        scenario, *_ = pb.build_demo(Path(parts))
        return pb.make_einstein_copy(einstein, target, scenario, udid=pb.DEMO_UDID, device_name=pb.DEMO_DEVICE_NAME)


if __name__ == "__main__":
    sys.exit(main())
