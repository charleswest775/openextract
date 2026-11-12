<!-- Podcasts extraction: the ios-backup-core extractor (PR #25, by gbaudic, plus a follow-up commit) and the app section built on it. Written 2026-11-12. -->

# Podcasts extraction

OpenExtract reads the Apple Podcasts library in a backup: the shows, which of them you follow, and the episodes you listened to. The reading is done by `PodcastExtractor` in ios-backup-core (`src/ios_backup_core/extractors/podcasts.py`), which gbaudic contributed in ios-backup-core#25. The app adds a Podcasts section, OPML and CSV saves, and counts on the home page.

## Where the library lives

One SQLite file, found through the manifest (`%MTLibrary.sqlite`, preferring the Podcasts container) rather than by a fixed name:

- Domain `AppDomainGroup-243LU875E5.groups.com.apple.podcasts`
- Path `Documents/MTLibrary.sqlite`

| iOS | Where | How we know |
|---|---|---|
| 13.3.1, 13.4.1 | as above | Public Hickman backups in the corpus |
| 15.3.1 | not in the backup | The Hickman 15.3.1 phone never used Podcasts; the app says "not in this backup" |
| 16.1.2, 17.3 | as above | Public Hickman backups in the corpus |
| 18 to 25 | assumed as above | Unverified: no public backup with Podcasts data yet |
| 26 | as above | The contributor's own backup |

Journal mode is `delete`, so there is no `-wal` to merge. Core Data entity numbers change between versions (MTPodcast is 4 on iOS 13, 5 on iOS 16), so nothing reads `Z_ENT`.

## What is read

The tables grow from about 49 columns (iOS 13) to about 100 (iOS 26). Every column is checked with `PRAGMA table_info` first, and a missing one reads as `None`.

`ZMTPODCAST`, one row per show the library knows about:

| Column | Field |
|---|---|
| `Z_PK` | `id` |
| `ZUUID` | `uuid` |
| `ZTITLE`, `ZAUTHOR` (else `ZPROVIDER`), `ZITEMDESCRIPTION`, `ZCATEGORY` | `title`, `author`, `description`, `category` |
| `ZUPDATEDFEEDURL`, else `ZFEEDURL` | `feed_url` (the newest address; two of six shows on iOS 16 and 17 had moved) |
| `ZFEEDURL` when it differs | `original_feed_url` |
| `ZWEBPAGEURL`, `ZIMAGEURL` | `webpage_url`, `image_url` (never fetched) |
| `ZSTORECLEANURL` / `ZSTORESHORTURL`, `ZSTORECOLLECTIONID` | `store_url`, `store_id` |
| `ZSUBSCRIBED`, `ZISIMPLICITLYFOLLOWED` (iOS 16+) | `subscribed`, `implicitly_followed`, `followed` |
| `ZHIDDEN`, `ZSHOWTYPEINFEED` | `hidden`, `show_type` |
| `ZADDEDDATE`, `ZLASTDATEPLAYED`, `ZLASTUNFOLLOWEDDATE` | `added_date`, `last_played_date`, `unfollowed_date` |
| `ZSORTORDER` | list order (then title) |

`ZMTEPISODE`, every episode the app has seen in each feed (1,024 rows on the 13.3.1 phone, 1,774 on 16.1.2 and 17.3):

| Column | Field |
|---|---|
| `Z_PK`, `ZPODCAST` | `id`, `podcast_id` |
| `ZUUID`, `ZGUID`, `ZTITLE`, `ZAUTHOR` | `uuid`, `guid`, `title`, `author` |
| `ZPUBDATE`, `ZDURATION` | `published_date`, `duration_seconds` |
| `ZPLAYCOUNT`, `ZPLAYHEAD`, `ZLASTDATEPLAYED` | `play_count`, `playhead_seconds`, `last_played_date`, and `listened` |
| `ZPLAYSTATE` | `play_state`: 0 `played`, 1 `in_progress`, 2 `unplayed` (inferred from the data; every 1 has a playhead) |
| `ZSAVED`, `ZISBOOKMARKED` (iOS 16+) | `saved` |
| `ZASSETURL` | `downloaded_on_phone` |
| `ZENCLOSUREURL`, `ZWEBPAGEURL` | `enclosure_url` (where the podcast publishes the audio), `webpage_url` |
| `ZSEASONNUMBER`, `ZEPISODENUMBER`, `ZEPISODETYPE`, `ZVIDEO` | `season`, `episode_number`, `episode_type`, `video` |
| `ZFEEDDELETED`, `ZISHIDDEN` / `ZUSERDELETED` | `removed_from_feed`, `hidden` |
| `ZITEMDESCRIPTIONWITHOUTHTML` | `description`, only when asked for (the app doesn't) |

Dates are Apple seconds (since 2001-01-01) and come back as ISO 8601 UTC strings. `ZHASBEENPLAYED` and `ZMARKASPLAYED` are always NULL on the versions checked and aren't used.

## Followed, and implicitly followed

`followed` is true when the show is `ZSUBSCRIBED = 1` and not `ZISIMPLICITLYFOLLOWED = 1`. From iOS 16 the app quietly "follows" a show you only played an episode of; those are kept as shows (with `implicitly_followed`) but aren't something you chose, so the screen lists them under "Not followed" (with shows you unfollowed) and the OPML save leaves them out. iOS 13 has no such column, so every subscribed show there is followed. All six shows on each Hickman phone are followed; no corpus backup has an implicit follow yet.

## Listened, and the "played" back catalogue

When you follow a show, the app marks its whole back catalogue `ZPLAYSTATE = 0` ("played"), about 1,000 of 1,024 rows on the 13.3.1 phone. So `play_state` is what the Podcasts app would show, not a record of listening. The listening history is `listened`: a play count above 0, a last played date, or a saved playhead. Each Hickman phone has only 5 to 7 such episodes. `listened_count` per show and `total_podcast_episodes_listened` on the home page count those.

## Why the audio is never there

`ZASSETURL` of a downloaded episode points into `/var/mobile/Media/Podcasts/` (`file:`), or `ipod-library:` for one synced from a computer. That folder isn't part of an iPhone backup, encrypted or not, and Manifest.db has no rows for it on any phone checked. So the app shows "Downloaded on the iPhone" as a fact about the phone, never plays or saves an episode itself, and says once, calmly: "Episode audio isn't kept in iPhone backups. Get audio opens an episode in your browser, from where the podcast publishes it." Get audio hands the episode's published audio address (`ZENCLOSUREURL`, http or https only) to the browser, which plays or downloads it; the app itself never fetches feeds, artwork or audio, and the renderer's content security policy blocks remote images anyway.

## The app

Engine (`python/podcasts.py`, over the library class; the import is guarded, so with a library that lacks the extractor Podcasts reads as not in the backup):

- `list_podcasts {udid}` and `list_podcast_episodes {udid, podcast_id?, listened_only?}` return the library's result unchanged. Empty results carry `empty_reason`: `not_in_backup` (no MTLibrary.sqlite) or `no_records` (a library with no shows); a library that is listed but can't be read is an `error` with no `empty_reason`.
- `export_podcasts {udid, output_dir, format}` starts with `export_`, so Electron gives it the long time limit. It never overwrites: a second save is `Podcasts (2).opml` and so on.
  - `opml`: `Podcasts.opml`, OPML 2.0, one `outline type="rss"` per followed show that has a feed, with `xmlUrl` and `htmlUrl`. Most podcast apps import it. Titled "Podcasts from <device name>" when the backup says the name.
  - `csv`: `Podcasts.csv` (every show: Title, Author, Followed, Feed URL, Website, Added, Last played, Episodes, Listened) and `Podcast episodes.csv` (every episode: Podcast, Title, Published, Duration (s), Listened, Play count, Last played, Position (s), State, Saved, Downloaded on iPhone, Audio URL, Web page). Dates in local time with their offset, UTF-8 with a BOM for Excel, and cells that start with `= + - @` or a tab are guarded against formulas.
  - Nothing to save is `{error, empty_reason}`, so the screen shows a calm notice and writes nothing.
- `get_backup_stats` overview: `total_podcasts`, `total_podcasts_followed`, `total_podcast_episodes_listened`, `podcasts_status`. `errors` gets a `podcasts: ...` line only for a real error.

Screen: a Podcasts tile and section after Voicemail, shown when the backup has shows or the library couldn't be read, and never listed as "Not in this backup" (most iPhones have never used Podcasts). The list starts with Listening history (every listened episode, most recently played first), then followed shows, then "Not followed". A show's page has its feed address, website and counts, and its episodes with a Listened / All episodes switch. The feedback area is `podcasts`.

## Tests

- Library: `tests/test_podcasts.py` in ios-backup-core, on built MTLibrary files for the iOS 13 and iOS 16+ layouts.
- Engine: `python/tests/podcasts_backup.py` builds a fictional MTLibrary in the iOS 13 and iOS 16+ layouts (backupgen has none, so the synthetic personas have no podcasts), with the cases that matter: an implicitly followed show, a followed show without a feed, titles OPML must escape and CSV must guard, and a back catalogue marked played that nobody heard. `test_podcasts_engine.py`, `test_podcasts_export.py` and the contract cases and empty states in `test_rpc_contract.py` run on it.
- Corpus (`python/tests/corpus/test_corpus_podcasts.py`): on each Hickman item, the RPCs against MTLibrary.sqlite read raw: show and episode ids, `followed`, `feed_url`, per-show episode and listened counts, `play_state`, `downloaded_on_phone` against the `ZASSETURL` scheme, plausible dates, no audio in the backup, the OPML feed set equal to the followed shows' feeds, and the CSV row counts. On 15.3.1 it checks the calm absence, including the home page counts and a save that writes nothing. `test_corpus_invariants.py` adds Podcasts to the no-errors, stats-agree and read-only-copy checks.

```bash
OPENEXTRACT_CORPUS_ITEMS=pub-hickman-13.3.1,pub-hickman-13.4.1,pub-hickman-15.3.1,pub-hickman-16.1.2,pub-hickman-17.3 \
  python -m pytest python/tests/corpus -m corpus -k "podcast or invariants"
```

Order to merge: ios-backup-core#25 (with the follow-up commit) first. CI clones library master, so the app's Podcasts tests fail there until the library has the extractor.

## Known gaps

- iOS 18 to 25 are unverified. If Apple moved or renamed the file, it would be found by name through the manifest; if it changed the tables, the screen would say the library couldn't be read.
- No corpus backup has an implicitly followed show, a hidden show or an `ipod-library:` episode, so those paths are covered only by built test libraries.
- Podcasts isn't in the Timeline, search, People or the Year view.
- Playlists and stations (`ZMTPLAYLIST`), and the Up Next queue, aren't read.
- Episode descriptions are read by the library but not shown or saved.
- Listening is known only as play count, last played date and where you stopped; the library doesn't keep each listen, so there's no full history of when.
- Artwork isn't shown, because it is only a web address and the app doesn't go online.
