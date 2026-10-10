# Backup test corpus

Tests OpenExtract against real iPhone backups. They check that nothing is silently dropped, that screens agree with each other, and that specific facts from each dataset creator's activity log come out right. The design, the inventory of public datasets and the roadmap are in [docs/BACKUP_TEST_CORPUS_PLAN.md](../docs/BACKUP_TEST_CORPUS_PLAN.md).

**Nothing in the corpus is stored in this repository.** The fetch tool downloads each backup into a local cache and checks its hash.

## Quick start

Run these from the repository root, with the Python environment you use for `python/` (see the main README).

```bash
python -m corpus.fetch list
python -m corpus.fetch fetch pub-hickman-15.3.1
pytest python/tests/corpus -m corpus -v
```

Without `-m corpus`, `pytest python/tests/` runs the corpus tooling's own unit tests. It also runs the corpus checks for any item that's already in your cache.

## What's here

| Path | What it is |
|---|---|
| `manifest.json` | Every public backup we can test against. For each one: where it comes from, how to fetch it, its SHA-256, any password the creator published, and the creator's terms. |
| `facts/<item>.json` | Spot facts taken from the creator's own activity log, such as "received an iMessage at 20:00" or "visited this site in a private tab". Text, names, numbers and file names are stored only as SHA-256 hashes. |
| `known_issues.json` | Checks that are expected to fail until a decision or a larger fix lands. Each one is a strict xfail: it turns red as soon as the issue is fixed, so the entry gets removed. |
| `fetch.py`, `remote.py` | The fetch tool: resumable downloads, single members of remote zips over range requests, members of remote `.tar.gz` files read as a stream, then hash checks and safe unpacking. |
| `facts.py` | Normalization, hashing and checking of spot facts. |
| `../python/tests/corpus/` | The tests. `sidecar_client.py` drives the real sidecar over JSON-RPC, and `raw_backup.py` reads the raw databases independently to supply the ground truth. |

## Cache and environment variables

| Variable | Meaning |
|---|---|
| `OPENEXTRACT_CORPUS_CACHE` | Cache folder (default `~/.cache/openextract-corpus`). Each item gets `<key>/download/` (the fetched archive), `<key>/backup/` (the unpacked backup) and `<key>/fetch.json`. |
| `OPENEXTRACT_CORPUS_ITEMS` | Comma-separated items to test (default: every fetched item). |
| `OPENEXTRACT_CORPUS_REQUIRE=1` | Fail, rather than skip, when a named item isn't fetched. The weekly job sets this. |
| `OPENEXTRACT_SIDECAR` | Test a built sidecar binary instead of `python/main.py`. |
| `OPENEXTRACT_CORPUS_SHOW=1` | Include extracted text in fact failure messages. **Local debugging only:** never paste that output into issues or PRs. |

## When it runs

- **Every PR** (`ci.yml`): the tooling unit tests. Nothing is downloaded.
- **Weekly** (`corpus-weekly.yml`): fetches every item in the `weekly` tier and runs all corpus checks. Run it by hand with a different item list, or against an `ios-backup-core` branch, from the Actions tab.

## Adding an item

1. Add it to `manifest.json`. Pin the SHA-256 the creator published; if they didn't publish one, pin the hash computed on the first fetch and say so in `notes`. Record the creator's terms.
2. Fetch it and run the corpus tests. Every invariant has to pass, or have an entry in `known_issues.json` that explains why.
3. Add a facts file. Pick 20 or more events from the creator's log that touch different data types, and write each value with `python -m corpus.facts hash-text "…"` or `hash-phone "…"`. Give every fact a `source_ref` that points back to the log entry.
4. Add `"weekly"` to the item's `tiers` once it's green.

## Rules for third-party data

- Don't commit backups, extracted databases, or text copied out of them. Hashes, counts and table definitions are fine.
- Don't put corpus data in screenshots, issues or PR descriptions.
- Never use credentials or tokens found inside a backup.
- Respect each creator's terms. They're recorded in `manifest.json`.
