<!-- Voice Memos extraction: the ios-backup-core extractor (VoiceMemoExtractor, extractors/voice_memos.py, and mp4.py for transcripts) and the app section built on it. Written 2026-11-20 from the design notes and Apple's own Voice Memos model in the iOS 26.5 Simulator runtime; no public backup with recordings has been checked yet. -->

# Voice Memos extraction

OpenExtract reads the Voice Memos app's recordings in a backup: their names, dates, lengths and folders, which are favourites, which are in Recently Deleted, the audio itself when it was on the iPhone, and the transcript iOS writes into a transcribed recording. The reading is done by `VoiceMemoExtractor` in ios-backup-core (`src/ios_backup_core/extractors/voice_memos.py`, with `src/ios_backup_core/mp4.py` for the transcript and tags inside the audio file). The app adds a Voice Memos section that plays recordings, audio and CSV saves, and counts on the home page.

Most of what follows comes from Apple's own Voice Memos data model and framework in Xcode's iOS 26.5 Simulator runtime (build 23F77), and from the empty databases in two public iOS 13 backups. No backup in the public corpus has a single recording, so none of the reading has been checked against a real library yet.

## Where the library lives

One SQLite database, `CloudRecordings.db`, with the audio files beside it in the same folder. It is found through the manifest (`%CloudRecordings.db`), preferring the app group, rather than by a fixed path:

| iOS | Domain | Folder | How we know |
|---|---|---|---|
| 12 to 16 | `MediaDomain` | `Media/Recordings/` | Public Hickman 13.3.1 and 13.4.1 backups (empty databases); not checked on 14 to 16 |
| 13 | `MediaDomain` | `Media/Recordings/Recordings.db` as well | The same Hickman backups: the older database is still there, also empty |
| 17 (likely) to 26 | `AppDomainGroup-group.com.apple.VoiceMemos.shared` | `Recordings/` | Apple's framework in the iOS 26.5 runtime, and a public iLEAPP report from an iOS 26.5 backup. Which release moved it isn't known; iOS 17 is likely |

When `CloudRecordings.db` is missing, or has no recordings and the older `Recordings.db` sits in the same folder, the older `ZRECORDING` table is read instead. One list never mixes the two. Paths under a recording's `.composition/` folder (kept for edited recordings) are never read as recordings.

Hickman 15.3.1, 16.1.2 and 17.3 have empty Voice Memos folders and no database (the app was never opened), so the app says Voice Memos isn't in the backup.

## What is read

`ZCLOUDRECORDING`, one row per recording. Every column is checked first, and a missing one reads as `None`:

| Column | Field |
|---|---|
| `Z_PK` | `id` (what the app passes as `memo_id`) |
| `ZUNIQUEID` | `unique_id` (its first 8 characters are in the file name) |
| `ZCUSTOMLABELFORSORTING`, else `ZENCRYPTEDTITLE`, `ZENCRYPTEDCUSTOMLABEL`, `ZCUSTOMLABEL` | `title`; from iOS 17 `ZCUSTOMLABEL` can hold a placeholder date, so it's the last resort. No title is made up: the screen says "Untitled recording" |
| `ZDATE` | `date` |
| `ZLOCALDURATION` when above 0, else `ZDURATION` | `duration_seconds` |
| `ZFOLDER` → `ZFOLDER.ZUUID`, `ZENCRYPTEDNAME` | `folder_id`, `folder` |
| `ZSHAREDFLAGS` bit 1, bit 2 | `is_favorite`, `is_enhanced` |
| `ZFLAGS` bits 0x40, 0x800, 0x1000, 0x400 | `recorded_on_watch` (or `ZSHAREDFLAGS` 0x40), `is_layered`, `is_spatial`, `has_transcript` |
| `ZFLAGS & 6` | `in_phone_list`, reported only: its meaning before iOS 26 isn't known, so it never hides a recording |
| `ZEVICTIONDATE` | `is_deleted`, `deleted_date`: this is the Recently Deleted date, not iCloud eviction |
| `ZPATH` | the audio file's name (`basename`, since older rows may hold an absolute path) |

`ZFOLDER` gives each folder: `id` (`ZUUID`), `name` (`ZENCRYPTEDNAME`), `rank` (`ZRANK`), and `count`, the recordings in it that aren't deleted. iOS 13 has no folders and no favourite flag; those fields are `null` there.

### The audio

The database's folder is listed once from the manifest. A recording's file is the one named by `ZPATH`, else the one whose name has the form `YYYYMMDD HHMMSS-<first 8 of ZUNIQUEID>.m4a` (or `.qta`, `.qt`). Listing never opens an audio file. When there's no file:

- `ZFLAGS & 2` set: the audio is in iCloud only and was never downloaded to the iPhone: `audio_missing_reason: "in_icloud_only"`.
- Otherwise: `audio_missing_reason: "not_in_backup"`.

Formats: AAC in `.m4a` by default, Apple Lossless in `.m4a` with Settings › Voice Memos › Audio Quality › Lossless, and QuickTime `.qta` for layered recordings (iOS 18.2 and later) and spatial ones. The app plays what Chromium can (AAC certainly; Apple Lossless and `.qta` are unverified) and opens the rest in another app.

### Transcripts

A transcribed recording (`ZFLAGS & 0x400`) keeps its transcript inside the audio file, not in the database: `moov/trak/udta/tsrp` in an `.m4a`, or a `com.apple.VoiceMemos.tsrp` metadata item in a `.qta`. `mp4.read_transcript` reads it by seeking through the file's boxes (it never reads the audio) and returns the text, its timed segments and its locale. A recording whose audio isn't in the backup has no transcript to read.

## The app

Engine (`python/voice_memos.py`, over the library class; the import is guarded, so with a library that lacks the extractor Voice Memos reads as not in the backup):

- `list_voice_memos {udid}` returns the library's result unchanged: `{voice_memos, folders}`, newest first. Empty results carry `empty_reason`: `not_in_backup` (no database) or `no_records` (a database with no recordings); an older layout is `unsupported_format` with an `error`; a database that is listed but can't be read is an `error` with no `empty_reason`.
- `get_voice_memo_audio {udid, memo_id, as_file?}` answers like WhatsApp's attachments: the audio as base64 (`{data, mime_type, memo_id, filename, size}`), or `{too_large: true, …}` past 25 MiB, or, with `as_file`, a copy under the recording's own name for another app (`{path, mime_type, filename, size, openable}`). A recording that isn't in the backup is `{error, empty_reason}` ("This recording isn't in the backup." or "This recording was kept in iCloud only, so it isn't in the backup."); an unknown id is `{error: "Recording not found."}`.
- `get_voice_memo_transcript {udid, memo_id}` returns `{memo_id, text, segments, locale}`, with `text: null` when there is none.
- `export_voice_memos {udid, output_dir, format, memo_ids?}` starts with `export_`, so Electron gives it the long time limit. It never overwrites: a second save is `Voice Memos (2)` and so on.
  - `recordings`: a `Voice Memos` folder with each recording whose audio is in the backup, named `<local YYYY-MM-DD HH.MM> <title>.m4a` and dated to when it was recorded, deleted ones under `Recently Deleted/`, each transcript beside its recording as a `.txt`, and `Voice Memos.csv`. With `memo_ids` (the screen's Save on one recording), just those files, straight into the folder.
  - `csv`: `Voice Memos.csv` alone: Title, Date, Duration, Folder, Favorite, Recently Deleted, Deleted Date, Recorded on Watch, Audio File, Transcript. Dates in local time with their offset, UTF-8 with a BOM for Excel, formula-guarded cells.
  - The result says how many were copied (`count`), and how many weren't in the backup (`not_in_backup`) or couldn't be copied (`failed`). Nothing to save is `{error, empty_reason}` and writes nothing. The screen offers "Audio files" only when at least one recording's audio is in the backup, and so does Save to computer, from the overview's `total_voice_memos_with_audio`.
- `get_backup_stats` overview: `total_voice_memos` (recordings not in Recently Deleted), `total_voice_memo_seconds`, `total_deleted_voice_memos` (recordings in Recently Deleted), `total_voice_memos_with_audio` (listed recordings, deleted ones too, whose audio is in the backup), `voice_memos_status`. `errors` gets a `voice memos: ...` line only for a real error.

Screen (`src/components/explore/VoiceMemoExplorer.tsx`, wording in `src/lib/voiceMemos.ts`): a Voice Memos tile and section after Podcasts, shown when the backup has recordings (in Recently Deleted alone too: the tile then has no number and says so, and the screen opens on that list) or they couldn't be read, and never listed as "Not in this backup" (many iPhones never record one). A sidebar like the app's: All Recordings, Favorites (when there are any), My folders, and Recently Deleted last, with one line saying what it holds. Each recording opens in place: it plays from memory (a `blob:` URL, since the page's content security policy allows no other kind of media address, freed when the recording closes, another opens, the list changes or the screen goes); one too long to hold in memory, or of a kind that can't play here, opens in another app; one whose audio isn't in the backup says why, and its audio is never asked for. A transcribed recording shows its transcript when it's opened, and search then finds its words; transcripts not opened yet aren't searched, and the no-match text says so. Each recording has its own Save. The feedback area is `voice_memos`.

## Tests

- Library (ios-backup-core): extractor tests on CloudRecordings databases built from the iOS 13.4.1 and 26.5 schemas, the legacy `Recordings.db`, and synthetic `.m4a` and `.qta` files with transcripts for `mp4.py`.
- Engine: `python/tests/voice_memos_backup.py` builds fictional libraries (a recording with its file, one listed but missing, one in iCloud only, a deleted one, a transcribed one); `test_voice_memos_engine.py`, `test_voice_memos_export.py`, and the contract cases and empty states in `test_rpc_contract.py` run on them. backupgen gives the synthetic Maren persona recordings, so the answer-key and e2e checks cover them too.
- App: `scripts/voice-memos.test.mjs` (wording and lists), `scripts/voice-memos-screen.test.mjs` (the screen: lists, playback and freeing memory, too long, can't play, missing audio, transcripts, search, saves, empty and unreadable states), `scripts/save-data.test.mjs` (`saveVoiceMemos`), and the e2e suites `screens`, `exports` and `empty`.
- Corpus (`python/tests/corpus/test_corpus_voice_memos.py`): states only, since no public backup has recordings: `no_records` on Hickman 13.3.1 and 13.4.1, `not_in_backup` on 15.3.1, 16.1.2 and 17.3, and a save that writes nothing.

Order to merge: the ios-backup-core change first. CI clones library master, so the app's Voice Memos tests fail there until the library has the extractor.

## Known gaps

- Nothing has been checked on a real library with recordings, on any iOS version. iOS 14 to 25 in particular: the folder move, the model's columns between versions 7 and 13, and what `ZFLAGS & 6` means before iOS 26 are unverified.
- Whether Chromium plays Apple Lossless `.m4a` and `.qta` recordings is unverified; those open in another app when they can't play.
- A recording over 25 MiB (roughly 50 minutes of AAC, a few minutes of lossless) isn't played in the app; it opens in another app.
- Voice Memos isn't in the Timeline, search, People, the Year view or the data bundle.
- Edits kept in a recording's `.composition` folder, waveforms and per-track files of layered recordings aren't read; the recording's main file is.
