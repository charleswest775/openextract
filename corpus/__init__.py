"""Backup test corpus tooling: the item manifest, the fetch tool and spot-fact helpers.

Nothing in the corpus itself lives in this repository. ``python -m corpus.fetch``
downloads items into a local cache (``~/.cache/openextract-corpus`` by default,
or ``$OPENEXTRACT_CORPUS_CACHE``). The tests in ``python/tests/corpus/`` run
against whatever is in that cache.

See docs/BACKUP_TEST_CORPUS_PLAN.md for the overall plan.
"""
