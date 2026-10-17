"""Spot facts: checks taken from a dataset creator's own activity log.

A facts file (``corpus/facts/<item>.json``) lists things the creator says they
did on the phone, such as "received an iMessage at 20:00" or "visited this site
in a private tab". Each fact is checked against what OpenExtract extracts. That
gives us an answer key that doesn't come from our own code.

Message text, names, phone numbers, file names and note titles are stored only
as SHA-256 hashes of a normalized form. That way the repository doesn't
redistribute third-party content. To write a fact, hash the value with:

    python -m corpus.facts hash-text "the exact message text"
    python -m corpus.facts hash-phone "919-555-0123"

Set ``OPENEXTRACT_CORPUS_SHOW=1`` to include extracted values in failure
messages when debugging locally. Never paste that output into issues or PRs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

FACTS_SCHEMA_VERSION = 1
KINDS = {
    "message",
    "message_absent",
    "call",
    "note",
    "browser_visit",
    "browser_visit_absent",
    "photo",
    "album",
}
_QUOTES = {
    ord("\u2018"): "'",
    ord("\u2019"): "'",
    ord("\u201c"): '"',
    ord("\u201d"): '"',
    ord("\ufffc"): " ",  # object replacement character Messages uses for inline attachments
}


class FactsError(ValueError):
    """A facts file is malformed."""


# ── normalization and hashing ────────────────────────────────────────────────


def normalize_text(value: str) -> str:
    """Case-fold, unify quotes and collapse whitespace so log text and DB text hash the same."""
    value = unicodedata.normalize("NFKC", value).translate(_QUOTES)
    return " ".join(value.split()).casefold()


def text_sha256(value: str) -> str:
    return hashlib.sha256(normalize_text(value).encode("utf-8")).hexdigest()


def normalize_phone(value: Any) -> str:
    """Digits only, without a leading NANP country code."""
    digits = re.sub(r"\D", "", str(value))
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


def phone_sha256(value: Any) -> str:
    return hashlib.sha256(normalize_phone(value).encode("utf-8")).hexdigest()


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO timestamp from the sidecar; naive values are UTC."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _show() -> bool:
    return os.environ.get("OPENEXTRACT_CORPUS_SHOW") == "1"


# ── facts files ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Fact:
    id: str
    kind: str
    source_ref: str
    expect: dict
    at: Optional[datetime] = None
    window: Optional[tuple[datetime, datetime]] = None
    tolerance: timedelta = timedelta(seconds=120)


@dataclass(frozen=True)
class FactSet:
    item: str
    source: dict
    facts: tuple[Fact, ...] = field(default_factory=tuple)

    def by_id(self) -> dict[str, Fact]:
        return {f.id: f for f in self.facts}


def _local(value: str, offset: str, where: str) -> datetime:
    try:
        return datetime.fromisoformat(f"{value}{offset}")
    except ValueError:
        raise FactsError(f"{where}: bad time '{value}' (expected YYYY-MM-DDTHH:MM)") from None


def load_facts(path: Path) -> FactSet:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("schema_version") != FACTS_SCHEMA_VERSION:
        raise FactsError(f"{path}: unsupported schema_version {data.get('schema_version')!r}")
    offset = data.get("source_utc_offset", "+00:00")
    if not re.match(r"^[+-]\d\d:\d\d$", offset):
        raise FactsError(f"{path}: source_utc_offset must look like -04:00")
    default_tolerance = data.get("defaults", {}).get("time_tolerance_s", 120)
    facts: list[Fact] = []
    seen: set[str] = set()
    for raw in data.get("facts", []):
        fid = raw.get("id")
        where = f"{path.name}: fact {fid!r}"
        if not fid or fid in seen:
            raise FactsError(f"{where}: missing or duplicate id")
        seen.add(fid)
        if raw.get("kind") not in KINDS:
            raise FactsError(f"{where}: unknown kind {raw.get('kind')!r}")
        if not raw.get("source_ref"):
            raise FactsError(f"{where}: missing source_ref (where in the creator's log this comes from)")
        at = _local(raw["at"], offset, where) if raw.get("at") else None
        window = None
        if raw.get("window"):
            start, end = raw["window"]
            window = (_local(start, offset, where), _local(end, offset, where))
        if raw["kind"] == "browser_visit_absent" and window is None:
            raise FactsError(f"{where}: browser_visit_absent needs a window")
        if raw["kind"] in ("message", "call", "browser_visit", "photo") and at is None:
            raise FactsError(f"{where}: {raw['kind']} needs 'at'")
        facts.append(
            Fact(
                id=fid,
                kind=raw["kind"],
                source_ref=raw["source_ref"],
                expect=dict(raw.get("expect", {})),
                at=at,
                window=window,
                tolerance=timedelta(seconds=raw.get("time_tolerance_s", default_tolerance)),
            )
        )
    return FactSet(item=data.get("item", path.stem), source=data.get("source", {}), facts=tuple(facts))


# ── evaluation ───────────────────────────────────────────────────────────────


@dataclass
class ExtractedData:
    """What the sidecar returned for one backup, flattened for fact matching."""

    messages: list[dict] = field(default_factory=list)  # each carries chat_id
    calls: list[dict] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)
    visits: list[dict] = field(default_factory=list)
    photos: list[dict] = field(default_factory=list)
    albums: list[dict] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)  # field name → why it couldn't be extracted


_SOURCE = {
    "message": "messages",
    "message_absent": "messages",
    "call": "calls",
    "note": "notes",
    "browser_visit": "visits",
    "browser_visit_absent": "visits",
    "photo": "photos",
    "album": "albums",
}


def _near(when: Optional[datetime], at: datetime, tolerance: timedelta) -> bool:
    return when is not None and abs(when - at) <= tolerance


def _attachment_names(message: dict) -> list[str]:
    names = []
    for attachment in message.get("attachments") or []:
        name = attachment.get("transfer_name") or os.path.basename(attachment.get("filename") or "")
        if name:
            names.append(name)
    return names


def _message_matches(message: dict, expect: dict) -> bool:
    if "is_from_me" in expect and bool(message.get("is_from_me")) != expect["is_from_me"]:
        return False
    if "text_sha256" in expect and text_sha256(message.get("text") or "") != expect["text_sha256"]:
        return False
    if "message_type" in expect and message.get("message_type") != expect["message_type"]:
        return False
    if "is_reaction" in expect and bool(message.get("is_reaction")) != expect["is_reaction"]:
        return False
    if "has_attachments" in expect and bool(message.get("has_attachments")) != expect["has_attachments"]:
        return False
    if "attachment_name_sha256" in expect:
        if expect["attachment_name_sha256"] not in {text_sha256(n) for n in _attachment_names(message)}:
            return False
    if "attachment_mime_prefix" in expect:
        mimes = [(a.get("mime_type") or "") for a in message.get("attachments") or []]
        if not any(m.startswith(expect["attachment_mime_prefix"]) for m in mimes):
            return False
    return True


def _describe_messages(candidates: list[dict], at: datetime) -> str:
    if not candidates:
        return "no messages within the time window"
    lines = []
    for m in sorted(candidates, key=lambda m: abs(parse_iso(m.get("date")) - at))[:5]:
        delta = (parse_iso(m.get("date")) - at).total_seconds()
        text = m.get("text") or ""
        shown = f" text={text!r}" if _show() else f" text_sha256={text_sha256(text)[:12]}…"
        lines.append(
            f"  {delta:+.0f}s from_me={bool(m.get('is_from_me'))} type={m.get('message_type')} "
            f"reaction={bool(m.get('is_reaction'))} attachments={len(m.get('attachments') or [])}{shown}"
        )
    return "nearest messages in the window:\n" + "\n".join(lines)


def _call_matches(call: dict, expect: dict) -> bool:
    for key in ("direction", "app", "status"):
        if key in expect and call.get(key) != expect[key]:
            return False
    if "duration_s" in expect:
        tolerance = expect.get("duration_tolerance_s", 15)
        if call.get("duration") is None or abs(float(call["duration"]) - expect["duration_s"]) > tolerance:
            return False
    if "address_sha256" in expect and phone_sha256(call.get("address") or "") != expect["address_sha256"]:
        return False
    return True


def _domain_matches(visit: dict, expect: dict) -> bool:
    if "browser" in expect and visit.get("browser") != expect["browser"]:
        return False
    domain = (visit.get("domain") or "").lower()
    if "domain" in expect and domain not in (expect["domain"], "www." + expect["domain"]):
        return False
    if "domain_suffix" in expect and not (domain == expect["domain_suffix"] or domain.endswith("." + expect["domain_suffix"])):
        return False
    return True


def evaluate(fact: Fact, data: ExtractedData) -> tuple[bool, str]:
    """Check one fact. Returns (ok, explanation)."""
    expect = fact.expect
    source = _SOURCE[fact.kind]
    if source in data.errors:
        return False, f"couldn't extract {source}: {data.errors[source]}"

    if fact.kind == "message":
        window = [m for m in data.messages if _near(parse_iso(m.get("date")), fact.at, fact.tolerance)]
        if any(_message_matches(m, expect) for m in window):
            return True, "found"
        return False, f"no message matching {expect} within ±{fact.tolerance} of {fact.at.isoformat()}\n" + _describe_messages(window, fact.at)

    if fact.kind == "message_absent":
        hits = [m for m in data.messages if text_sha256(m.get("text") or "") == expect["text_sha256"]]
        if not hits:
            return True, "absent as expected"
        return False, f"expected no message with this text, found {len(hits)} (dates: {[m.get('date') for m in hits]})"

    if fact.kind == "call":
        window = [c for c in data.calls if _near(parse_iso(c.get("date")), fact.at, fact.tolerance)]
        if any(_call_matches(c, expect) for c in window):
            return True, "found"
        summary = [
            f"  {(parse_iso(c.get('date')) - fact.at).total_seconds():+.0f}s {c.get('direction')} {c.get('app')} "
            f"{c.get('status')} duration={c.get('duration')}"
            for c in window
        ]
        return False, f"no call matching {expect} within ±{fact.tolerance} of {fact.at.isoformat()}; in window:\n" + (
            "\n".join(summary) or "  (none)"
        )

    if fact.kind == "note":
        notes = [n for n in data.notes if text_sha256(n.get("title") or "") == expect["title_sha256"]]
        if not notes:
            return False, f"no note with that title among {len(data.notes)} notes"
        if fact.at is not None:
            dated = [n for n in notes if _near(parse_iso(n.get("created")), fact.at, fact.tolerance)]
            if not dated:
                return False, f"note found but its created date is {[n.get('created') for n in notes]}, expected ≈ {fact.at.isoformat()}"
        return True, "found"

    if fact.kind == "browser_visit":
        window = [v for v in data.visits if _near(parse_iso(v.get("visit_date")), fact.at, fact.tolerance)]
        if any(_domain_matches(v, expect) for v in window):
            return True, "found"
        return False, f"no visit matching {expect} near {fact.at.isoformat()}; domains in window: {sorted({v.get('domain') for v in window})}"

    if fact.kind == "browser_visit_absent":
        start, end = fact.window
        hits = [
            v for v in data.visits
            if _domain_matches(v, expect) and (d := parse_iso(v.get("visit_date"))) is not None and start <= d <= end
        ]
        if not hits:
            return True, "absent as expected"
        return False, f"expected no visit, found {len(hits)}: {[(v.get('domain'), v.get('visit_date')) for v in hits]}"

    if fact.kind == "photo":
        window = [p for p in data.photos if _near(parse_iso(p.get("date_created")), fact.at, fact.tolerance)]
        if "kind" in expect:
            window = [p for p in window if p.get("kind") == expect["kind"]]
        if window:
            return True, "found"
        dated = sum(1 for p in data.photos if p.get("date_created"))
        return False, f"no photo within ±{fact.tolerance} of {fact.at.isoformat()} ({dated}/{len(data.photos)} photos have a date)"

    if fact.kind == "album":
        albums = [a for a in data.albums if text_sha256(a.get("title") or a.get("name") or "") == expect["title_sha256"]]
        if not albums:
            return False, f"no album with that title among {len(data.albums)} albums"
        if "count" in expect:
            counts = [a.get("count", a.get("asset_count")) for a in albums]
            if expect["count"] not in counts:
                return False, f"album found with count {counts}, expected {expect['count']}"
        return True, "found"

    raise FactsError(f"unknown kind {fact.kind}")  # load_facts rejects these


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m corpus.facts", description="Hash values for spot facts.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("hash-text", "hash-phone"):
        p = sub.add_parser(name)
        p.add_argument("value")
    p_check = sub.add_parser("check", help="validate facts files")
    p_check.add_argument("paths", nargs="*", type=Path)
    args = parser.parse_args(argv)
    if args.command == "hash-text":
        print(text_sha256(args.value))
    elif args.command == "hash-phone":
        print(phone_sha256(args.value))
    else:
        from corpus.manifest import FACTS_DIR

        for path in args.paths or sorted(FACTS_DIR.glob("*.json")):
            facts = load_facts(path)
            print(f"{path.name}: {len(facts.facts)} facts OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
