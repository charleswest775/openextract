"""Podcasts invariants for every backup in the corpus.

What the engine's Podcasts methods return, checked against MTLibrary.sqlite
read directly (``raw_backup.RawBackup``, not ios-backup-core): every show and
every episode row is listed once, "followed" means the user chose to follow
the show (not only implicitly followed), the feed address is the newest one
the app knows, listening history comes from play counts, last played dates and
playheads rather than the app's "played" state, and nothing claims the audio is
in the backup, because an iPhone backup never holds it. The OPML and CSV saves
carry the same shows and episodes the screen lists.

Failure messages name ids and counts only, never titles or addresses from a backup.
"""

import csv
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from corpus.facts import parse_iso

pytestmark = pytest.mark.corpus

DOMAIN = "AppDomainGroup-243LU875E5.groups.com.apple.podcasts"
PODCASTS = (DOMAIN, "Documents/MTLibrary.sqlite")
EARLIEST_LISTENING = datetime(2005, 1, 1, tzinfo=timezone.utc)  # Podcasts came to iTunes in 2005
EARLIEST_PUBLISHED = datetime(1995, 1, 1, tzinfo=timezone.utc)  # feeds can carry old back catalogues
# Feeds sometimes date an episode a little ahead (scheduled releases, time zones).
PUBLISHED_SLACK = timedelta(days=31)
PLAY_STATES = {0: "played", 1: "in_progress", 2: "unplayed"}
# Keys that would say an episode's audio file is in the backup. None may be truthy.
AUDIO_IN_BACKUP_KEYS = ("audio_path", "audio_file", "local_path", "file", "filename", "available", "in_backup")


def _sample(values, limit=5):
    values = list(values)
    return f"{values[:limit]}{' …' if len(values) > limit else ''} ({len(values)} total)"


def _latest(ctx) -> datetime:
    return (ctx.backup_date or datetime.now(timezone.utc)) + timedelta(days=1)


def _text(value):
    """A TEXT cell as the library reads it: bytes decoded, stripped, empty as None."""
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        value = bytes(value).decode("utf-8", errors="replace")
    value = str(value).strip()
    return value or None


def _find_library(raw):
    """(domain, path) of MTLibrary.sqlite, preferring the Podcasts container, or None."""
    if raw.has_file(*PODCASTS):
        return PODCASTS
    found = [(d, p) for d, p in raw.find_files("%MTLibrary.sqlite") if p.endswith("MTLibrary.sqlite")]
    found.sort(key=lambda f: ("com.apple.podcasts" not in f[0].lower(), f[1] != PODCASTS[1]))
    return found[0] if found else None


class Library:
    """MTLibrary.sqlite, read raw: what the app should list."""

    def __init__(self, ctx):
        ctx.require_open()
        where = _find_library(ctx.raw)
        conn = ctx.raw.connect(*where) if where else None
        if conn is None:
            pytest.skip("no Podcasts library in this backup")
        self.conn = conn
        tables = ctx.raw.tables(conn)
        show_cols = ctx.raw.columns(conn, "ZMTPODCAST") if "ZMTPODCAST" in tables else set()
        ep_cols = ctx.raw.columns(conn, "ZMTEPISODE") if "ZMTEPISODE" in tables else set()

        def col(cols, name, fallback="NULL"):
            return name if name in cols else fallback

        self.shows = {}
        if show_cols:
            for r in conn.execute(
                f"SELECT Z_PK, ZSUBSCRIBED, {col(show_cols, 'ZISIMPLICITLYFOLLOWED', '0')} AS implicit, "
                f"{col(show_cols, 'ZFEEDURL')} AS feed, {col(show_cols, 'ZUPDATEDFEEDURL')} AS updated_feed "
                f"FROM ZMTPODCAST"
            ):
                self.shows[r["Z_PK"]] = {
                    "followed": (r["ZSUBSCRIBED"] or 0) == 1 and not (r["implicit"] or 0),
                    # COALESCE(NULLIF(ZUPDATEDFEEDURL, ''), ZFEEDURL), with the library's trimming.
                    "feed_url": _text(r["updated_feed"]) or _text(r["feed"]),
                }

        listened = " OR ".join(
            f"COALESCE({c}, 0) > 0" for c in ("ZPLAYCOUNT", "ZLASTDATEPLAYED", "ZPLAYHEAD") if c in ep_cols
        ) or "0"
        self.episodes = {}
        if ep_cols:
            for r in conn.execute(
                f"SELECT Z_PK, {col(ep_cols, 'ZPODCAST')} AS podcast, {col(ep_cols, 'ZPLAYSTATE')} AS play_state, "
                f"{col(ep_cols, 'ZASSETURL')} AS asset, ({listened}) AS listened FROM ZMTEPISODE"
            ):
                self.episodes[r["Z_PK"]] = {
                    "podcast_id": r["podcast"],
                    "play_state": r["play_state"],
                    "asset": _text(r["asset"]),
                    "listened": bool(r["listened"]),
                }
        self.by_show = defaultdict(set)
        for eid, e in self.episodes.items():
            self.by_show[e["podcast_id"]].add(eid)

    def listened_count(self, show_id) -> int:
        return sum(1 for eid in self.by_show.get(show_id, ()) if self.episodes[eid]["listened"])

    def close(self):
        self.conn.close()


@pytest.fixture
def library(ctx):
    lib = Library(ctx)
    yield lib
    lib.close()


@pytest.fixture
def episodes(ctx, library):
    result = ctx.podcast_episodes_result
    assert "error" not in result, f"list_podcast_episodes: {result.get('error')!r}"
    if not library.episodes:
        assert result == {"episodes": [], "empty_reason": "no_records"}, sorted(result)
    return result.get("episodes", [])


def _files_under(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file())


def test_podcasts_absent_is_calm(ctx, tmp_path):
    """A backup without a Podcasts library says so, without an error, on the screen, in the counts and on save."""
    ctx.require_open()
    if _find_library(ctx.raw):
        pytest.skip("this backup has a Podcasts library")
    assert ctx.podcasts_result == {"podcasts": [], "empty_reason": "not_in_backup"}
    assert ctx.podcast_episodes_result == {"episodes": [], "empty_reason": "not_in_backup"}
    o = ctx.stats.get("overview", {})
    counts = (o.get("total_podcasts"), o.get("total_podcasts_followed"),
              o.get("total_podcast_episodes_listened"), o.get("podcasts_status"))
    assert counts == (0, 0, 0, "not_in_backup"), counts
    for fmt in ("opml", "csv"):
        out = tmp_path / fmt
        out.mkdir()
        result = ctx.rpc("export_podcasts", output_dir=str(out), format=fmt)
        assert result == {"error": "There are no podcasts in this backup to save.", "empty_reason": "not_in_backup"}, \
            sorted(result)
        assert _files_under(out) == [], f"{fmt}: wrote {len(_files_under(out))} files for a backup without podcasts"


def test_podcasts_match_mtlibrary(ctx, library):
    result = ctx.podcasts_result
    assert "error" not in result, f"list_podcasts: {result.get('error')!r}"
    listed = {p["id"]: p for p in ctx.podcasts}
    assert len(listed) == len(ctx.podcasts), "a show is listed twice"
    assert set(listed) == set(library.shows), (
        f"missing shows {_sample(sorted(set(library.shows) - set(listed)))}, "
        f"unexpected shows {_sample(sorted(set(listed) - set(library.shows)))}"
    )
    if not library.shows:
        assert result.get("empty_reason") == "no_records"
        return
    followed = {sid: (listed[sid]["followed"], raw["followed"])
                for sid, raw in library.shows.items() if listed[sid]["followed"] is not raw["followed"]}
    assert not followed, f"followed differs from ZSUBSCRIBED / ZISIMPLICITLYFOLLOWED for shows (listed, raw): {followed}"
    implicit = [p["id"] for p in ctx.podcasts if p["followed"] and p.get("implicitly_followed")]
    assert not implicit, f"shows both followed and only implicitly followed: {_sample(implicit)}"
    feeds = [sid for sid, raw in library.shows.items() if listed[sid]["feed_url"] != raw["feed_url"]]
    assert not feeds, f"feed_url isn't the newest feed address (ZUPDATEDFEEDURL, else ZFEEDURL) for shows {_sample(feeds)}"
    counts = {sid: (listed[sid]["episode_count"], len(library.by_show.get(sid, ())))
              for sid in library.shows if listed[sid]["episode_count"] != len(library.by_show.get(sid, ()))}
    assert not counts, f"episode_count differs from ZMTEPISODE rows for shows (listed, rows): {counts}"
    heard = {sid: (listed[sid]["listened_count"], library.listened_count(sid))
             for sid in library.shows if listed[sid]["listened_count"] != library.listened_count(sid)}
    assert not heard, f"listened_count differs from play count / last played / playhead for shows (listed, raw): {heard}"


def test_podcast_dates_are_plausible(ctx, library):
    latest = _latest(ctx)
    bad = defaultdict(list)
    for p in ctx.podcasts:
        for field in ("added_date", "last_played_date", "unfollowed_date"):
            value = p.get(field)
            if value is not None and not ((d := parse_iso(value)) and EARLIEST_LISTENING <= d <= latest):
                bad[f"show.{field}"].append(p["id"])
    for e in ctx.result_or_empty("podcast_episodes_result").get("episodes", []):
        value = e.get("last_played_date")
        if value is not None and not ((d := parse_iso(value)) and EARLIEST_LISTENING <= d <= latest):
            bad["episode.last_played_date"].append(e["id"])
        value = e.get("published_date")
        if value is not None and not ((d := parse_iso(value)) and EARLIEST_PUBLISHED <= d <= latest + PUBLISHED_SLACK):
            bad["episode.published_date"].append(e["id"])
    assert not bad, f"impossible dates (ids): { {k: _sample(v) for k, v in bad.items()} }"


def test_every_episode_listed_once(ctx, library, episodes):
    ids = [e["id"] for e in episodes]
    assert len(ids) == len(set(ids)), f"{len(ids) - len(set(ids))} episodes listed twice"
    assert len(ids) == len(library.episodes), f"listed {len(ids)} episodes, ZMTEPISODE has {len(library.episodes)}"
    listed_by_show = defaultdict(set)
    for e in episodes:
        listed_by_show[e["podcast_id"]].add(e["id"])
    wrong = {sid: (len(listed_by_show.get(sid, ())), len(raw))
             for sid, raw in library.by_show.items() if listed_by_show.get(sid, set()) != raw}
    extra = sorted(set(listed_by_show) - set(library.by_show), key=str)
    assert not wrong and not extra, f"episodes per show differ from ZMTEPISODE (listed, rows): {wrong}; unknown shows {extra}"
    # One show at a time, as the show's page asks for them.
    for sid in sorted(sid for sid in library.by_show if sid is not None)[:3]:
        page = ctx.rpc("list_podcast_episodes", podcast_id=sid)
        got = {e["id"] for e in page.get("episodes", [])}
        assert got == library.by_show[sid], f"show {sid}: listed {len(got)} episodes, ZMTEPISODE has {len(library.by_show[sid])}"
        heard = ctx.rpc("list_podcast_episodes", podcast_id=sid, listened_only=True)
        got = {e["id"] for e in heard.get("episodes", [])}
        want = {eid for eid in library.by_show[sid] if library.episodes[eid]["listened"]}
        assert got == want, f"show {sid}: listened_only gave {len(got)} episodes, raw has {len(want)} listened"
        if not want:
            assert heard.get("empty_reason") == "no_records", f"show {sid}: no listened episodes but {sorted(heard)}"
    published = [parse_iso(e.get("published_date")) or datetime.min.replace(tzinfo=timezone.utc) for e in episodes]
    assert published == sorted(published, reverse=True), "episodes aren't newest published first"


def test_episode_fields_match_mtlibrary(ctx, library, episodes):
    states, heard, downloads, counts, audio = [], [], [], [], []
    for e in episodes:
        raw = library.episodes[e["id"]]
        if e.get("play_state") != PLAY_STATES.get(raw["play_state"]):
            states.append(e["id"])
        if e.get("listened") is not raw["listened"]:
            heard.append(e["id"])
        on_phone = bool(raw["asset"]) and raw["asset"].startswith(("file:", "ipod-library:"))
        if e.get("downloaded_on_phone") is not on_phone:
            downloads.append(e["id"])
        if e.get("listened") and not (e.get("play_count") or e.get("playhead_seconds") or e.get("last_played_date")):
            counts.append(e["id"])
        if any(e.get(key) for key in AUDIO_IN_BACKUP_KEYS):
            audio.append(e["id"])
    assert not states, f"play_state isn't ZPLAYSTATE 0/1/2 as played/in_progress/unplayed for episodes {_sample(states)}"
    assert not heard, f"listened differs from play count / last played / playhead for episodes {_sample(heard)}"
    assert not downloads, f"downloaded_on_phone differs from the ZASSETURL scheme for episodes {_sample(downloads)}"
    assert not counts, f"listened without a play count, playhead or last played date for episodes {_sample(counts)}"
    assert not audio, f"episodes that claim their audio is in the backup: {_sample(audio)}"


def test_episode_audio_is_never_in_the_backup(ctx, library):
    """What the docs and the screen say: downloaded episodes live in /var/mobile/Media/Podcasts, which isn't backed up."""
    on_phone = sum(1 for e in library.episodes.values()
                   if e["asset"] and e["asset"].startswith(("file:", "ipod-library:")))
    audio = [f for f in ctx.raw.find_files("Podcasts/%", "MediaDomain")
             if f[1].lower().endswith((".mp3", ".m4a", ".aac", ".mp4", ".m4v", ".mov"))]
    assert not audio, f"{len(audio)} podcast audio files are in this backup ({on_phone} episodes were on the iPhone)"


def test_podcasts_opml_round_trip(ctx, library, tmp_path):
    if not library.shows:
        pytest.skip("no shows")
    want = {p["feed_url"] for p in ctx.podcasts if p["followed"] and p.get("feed_url")}
    result = ctx.rpc("export_podcasts", output_dir=str(tmp_path), format="opml")
    if not want:
        assert result == {"error": "None of the podcasts in this backup have a feed address to save.",
                          "empty_reason": "no_records"}, sorted(result)
        assert _files_under(tmp_path) == []
        return
    assert "error" not in result, result.get("error")
    path = Path(result["path"])
    assert result.get("status") == "success" and path.name == "Podcasts.opml", sorted(result)
    assert result.get("files") == [str(path)], f"files: {len(result.get('files') or [])}"
    root = ET.parse(path).getroot()
    assert root.tag == "opml" and root.get("version") == "2.0"
    outlines = root.findall("./body/outline")
    got = [o.get("xmlUrl") for o in outlines]
    assert result["count"] == len(outlines), f"count {result['count']}, the file has {len(outlines)} outlines"
    assert len(got) == len(set(got)) and set(got) == want, (
        f"OPML has {len(got)} feeds ({len(set(got))} distinct), {len(want)} followed shows have a feed; "
        f"{len(want - set(got))} missing, {len(set(got) - want)} not followed"
    )
    again = ctx.rpc("export_podcasts", output_dir=str(tmp_path), format="opml")
    assert Path(again["path"]).name == "Podcasts (2).opml", "a second save overwrote the first"


def test_podcasts_csv_export_counts(ctx, library, episodes, tmp_path):
    if not library.shows:
        pytest.skip("no shows")
    result = ctx.rpc("export_podcasts", output_dir=str(tmp_path), format="csv")
    assert "error" not in result, result.get("error")
    names = sorted(Path(f).name for f in result.get("files", []))
    assert names == ["Podcast episodes.csv", "Podcasts.csv"], names
    assert Path(result["path"]).name == "Podcasts.csv"
    assert result["count"] == len(ctx.podcasts), f"count {result['count']}, {len(ctx.podcasts)} shows listed"
    rows = {}
    for f in result["files"]:
        with open(f, newline="", encoding="utf-8-sig") as fh:
            rows[Path(f).name] = list(csv.reader(fh))
    assert len(rows["Podcasts.csv"]) - 1 == len(ctx.podcasts), (
        f"Podcasts.csv has {len(rows['Podcasts.csv']) - 1} rows, the app lists {len(ctx.podcasts)} shows")
    assert len(rows["Podcast episodes.csv"]) - 1 == len(episodes), (
        f"Podcast episodes.csv has {len(rows['Podcast episodes.csv']) - 1} rows, the app lists {len(episodes)} episodes")
    assert rows["Podcasts.csv"][0][:2] == ["Title", "Author"], "Podcasts.csv header"
    assert rows["Podcast episodes.csv"][0][:2] == ["Podcast", "Title"], "Podcast episodes.csv header"
