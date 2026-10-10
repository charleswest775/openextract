"""Spot facts: checks taken from each dataset creator's own activity log (corpus/facts/*.json)."""

import pytest

from corpus.facts import evaluate, load_facts

pytestmark = pytest.mark.corpus


def test_spot_fact(corpus, fact_case):
    key, fact_id = fact_case
    ctx = corpus.context(key)
    ctx.require_open()
    fact = load_facts(ctx.item.facts_path()).by_id()[fact_id]
    ok, detail = evaluate(fact, ctx.extracted_data())
    assert ok, f"{fact.source_ref}: {detail}"
