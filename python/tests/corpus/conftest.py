"""Fixtures for the corpus tests.

Corpus tests run against backups fetched into the local cache with
``python -m corpus.fetch``. Items that aren't fetched are skipped, so these
tests are inert in the normal PR run. Environment variables:

- ``OPENEXTRACT_CORPUS_ITEMS``: comma-separated item keys to test (default: all).
- ``OPENEXTRACT_CORPUS_REQUIRE=1``: fail, rather than skip, when an item isn't fetched.
- ``OPENEXTRACT_CORPUS_CACHE``: cache folder (default ``~/.cache/openextract-corpus``).
- ``OPENEXTRACT_SIDECAR``: path to a built sidecar binary to test, rather than ``python/main.py``.
"""

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
for path in (str(REPO_ROOT), str(HERE)):
    if path not in sys.path:
        sys.path.insert(0, path)

from corpus.facts import load_facts  # noqa: E402
from corpus.manifest import CORPUS_DIR, load_manifest  # noqa: E402
from corpus_runtime import CorpusRuntime, selected_keys  # noqa: E402

KNOWN_ISSUES_PATH = CORPUS_DIR / "known_issues.json"


def pytest_configure(config):
    config.addinivalue_line("markers", "corpus: runs against backups in the corpus cache")


def pytest_generate_tests(metafunc):
    if "corpus_key" not in metafunc.fixturenames and "fact_case" not in metafunc.fixturenames:
        return
    items = load_manifest()
    keys = selected_keys(items)
    if "corpus_key" in metafunc.fixturenames:
        metafunc.parametrize("corpus_key", keys, ids=keys)
    if "fact_case" in metafunc.fixturenames:
        cases = []
        for key in keys:
            path = items[key].facts_path()
            if path.exists():
                cases += [(key, fact.id) for fact in load_facts(path).facts]
        metafunc.parametrize("fact_case", cases, ids=[f"{k}:{f}" for k, f in cases])


def _known_issues() -> dict[tuple[str, str], str]:
    """(item key, test name or fact id) → reason. Listed issues are strict xfails."""
    if not KNOWN_ISSUES_PATH.exists():
        return {}
    data = json.loads(KNOWN_ISSUES_PATH.read_text(encoding="utf-8"))
    return {(entry["item"], entry["check"]): entry["reason"] for entry in data.get("issues", [])}


def pytest_collection_modifyitems(config, items):
    known = _known_issues()
    for test in items:
        if "corpus" not in test.keywords:
            continue
        params = getattr(test, "callspec", None)
        if params is None:
            continue
        fact_case, corpus_key = params.params.get("fact_case"), params.params.get("corpus_key")
        if isinstance(fact_case, tuple):
            key, check = fact_case
        elif isinstance(corpus_key, str):
            key, check = corpus_key, test.originalname
        else:
            continue  # empty parameter set: nothing fetched
        reason = known.get((key, check))
        if reason:
            test.add_marker(pytest.mark.xfail(reason=f"known issue: {reason}", strict=True))


@pytest.fixture(scope="session")
def corpus():
    runtime = CorpusRuntime()
    yield runtime
    runtime.close()


@pytest.fixture
def ctx(corpus, corpus_key):
    return corpus.context(corpus_key)
