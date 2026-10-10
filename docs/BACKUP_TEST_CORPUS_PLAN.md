# Backup Test Corpus — Plan

**Status:** Phase 0 built (see [§11](#11-roadmap)); later phases proposed · **Last updated:** 2026-10-10

A plan for a test suite that we run on a schedule. It checks, against known correct answers, that OpenExtract reads the iPhone backups real people actually have. That means backups made on any iOS from 10 (2016) to 27 (2026), on a Mac or a Windows PC, encrypted or not, holding years of data at realistic volume.

**Contents**

1. [Goal and scope](#1-goal-and-scope)
2. [What "realistic over 5–10 years" means](#2-what-realistic-over-510-years-means)
3. [What already exists](#3-what-already-exists)
4. [Gaps](#4-gaps)
5. [Design: four layers](#5-design-four-layers)
6. [The synthetic generator (L4)](#6-the-synthetic-generator-l4)
7. [Reference devices (L3)](#7-reference-devices-l3)
8. [Test harness and assertions](#8-test-harness-and-assertions)
9. [Cadence and infrastructure](#9-cadence-and-infrastructure)
10. [Data handling rules](#10-data-handling-rules)
11. [Roadmap](#11-roadmap)
12. [Decisions needed](#12-decisions-needed)
13. [Risks](#13-risks)
- [Appendix A: Fetch notes and hashes](#appendix-a-fetch-notes-and-hashes)
- [Appendix B: Where each data type lives in a backup](#appendix-b-where-each-data-type-lives-in-a-backup)
- [Appendix C: Schema and format references](#appendix-c-schema-and-format-references)
- [Appendix D: Coverage matrix](#appendix-d-coverage-matrix)

---

## 1. Goal and scope

**In scope**

- **Data types:** every type OpenExtract extracts or is adding on feature branches:
  - Messages (with attachments and deleted-message recovery)
  - Contacts
  - Calls
  - Voicemail
  - Notes
  - Photos
  - Browser history (Safari, Chromium-family, Firefox)
  - Calendar
  - Voice Memos
  - Health
- **Backup-level behaviour:**
  - finding backups
  - checking passwords and decrypting
  - stats
  - export

**Out of scope:** iCloud backups, full-file-system (FFS) extractions as a product input, and third-party apps we don't extract yet. Those (for example WhatsApp) can be added later as extra writers.

**Principles**

1. **Every item in the corpus has an answer key.** "It didn't crash" is necessary but not enough.
2. **The public repo only holds what's ours.** That means code, schemas (table definitions only, never rows), manifests (URLs and hashes) and our own made-up data. It never holds third-party data or anything extracted from it.
3. **Screenshots and marketing use only our fictional person.**
4. **Results are reproducible.** For a given generator version and seed, the output is identical byte for byte. Every download is pinned by its hash.

## 2. What "realistic over 5–10 years" means

There are two separate axes:

- **Breadth: old backups sitting on disk.** People keep backups for years and come to us with ones made on phones they no longer have.
  - Every backup format from iOS 10 onward must work.
  - A backup from before iOS 10 (`Manifest.mbdb`) must be detected and explained, not crash.
- **Depth: ten years inside one backup.** A current backup's databases still contain rows written in 2016.
  - Those rows have been through every iOS upgrade's migration and every phone switch (each switch is a restore from backup).
  - Old rows keep old conventions, sitting next to new ones.

### Checklist of what has to vary

| Area | What varies |
|---|---|
| Container format | `Manifest.mbdb` (iOS 9 and earlier) vs `Manifest.db` (10+). `Manifest.db` is itself encrypted from 10.2. The keybag/PBKDF2 scheme changes: 10.2+ adds a 10M-round SHA-256 pass. The fields in `Info.plist`, `Manifest.plist` and `Status.plist` differ by era |
| Host software | Finder (macOS 10.15+); iTunes for Mac (10.14 and earlier); iTunes for Windows (desktop installer and Microsoft Store builds); Apple Devices for Windows; `pymobiledevice3` / libimobiledevice |
| Location | `~/Library/Application Support/MobileSync/Backup` (needs Full Disk Access); `%APPDATA%\Apple Computer\MobileSync\Backup`; `%USERPROFILE%\Apple\MobileSync\Backup`; custom folders and external drives. Archived backups (renamed copies). Several iPhones and iPads backed up to one computer |
| State | Complete; interrupted or still in progress; partly copied; corrupt `Manifest.db`; files the manifest lists but that are missing |
| Encryption | None; encrypted with the correct, a wrong or an unknown password; real vs low iteration counts |
| What's included | Data only in encrypted backups: Health, call history, Safari history, keychain, Wi-Fi ([Apple 108353](https://support.apple.com/en-us/108353)). Data synced to iCloud can be partly missing: Messages in iCloud, iCloud Photos with "Optimize Storage", attachments in iCloud Notes. Apps can also opt files out of backups |
| Schema drift | Per data type, across major **and** point releases. For example, iOS 26.5 added four columns to `ZCALLRECORD` |
| SQLite state | `-wal` files holding rows that haven't been written into the main file yet; free pages still holding deleted rows (used by the recovery feature); databases several GB in size |
| Volume | From an almost empty phone up to a heavy user with ten years of data |

### Content on a phone used for years (all fictional)

- **Messages**
  - **Scale:** 50k–300k+ messages across hundreds of chats.
  - **Chats:** group chats renamed, with members added and leaving; a mix of iMessage, SMS, MMS and RCS.
  - **Senders and handles:** short codes (2FA codes, delivery alerts); email addresses as handles; international numbers; contacts deleted later, leaving numbers with no name; a contact who changed number.
  - **Message features:**
    - tapbacks from every era, including any-emoji tapbacks (iOS 18)
    - replies, mentions, edits and unsends
    - stickers, effects, Digital Touch, handwriting
    - audio messages, Apple Pay/Apple Cash bubbles, app bubbles
  - **Attachments:** every format (JPEG, HEIC, Live Photo, MOV, CAF/AMR, PDF, vCard, location), with some files missing.
- **Contacts:** 300–1,500 cards. Some have photos, several numbers or emails, formatting from different eras, linked cards, or names with emoji, right-to-left or CJK scripts.
- **Photos:** 10k–40k items. Includes Live Photos, videos, screenshots, bursts, edited photos, hidden and recently deleted items, albums, shared albums, and GPS and time zones from travel.
- **Calls and voicemail:** 10k+ calls (cellular, FaceTime audio and video, VoIP apps that use CallKit). Voicemails with and without transcripts.
- **Notes:** 100–800 notes. Includes locked notes, checklists, tables, attachments, folders, and notes in the old format carried forward.
- **Browser, calendar, voice memos, health:** several years of each. Health on someone with an Apple Watch means millions of samples.
- **Time:** daylight-saving changes, travel across time zones, leap days, and the point where Messages switched from seconds to nanoseconds.

These volume ranges are working assumptions. We'll calibrate them against our reference devices (L3).

## 3. What already exists

The survey was done on 2026-10-08. It covered:
- the NIST CFReDS catalogue (271 datasets)
- Digital Corpora
- [The Evidence Locker](https://theevidencelocker.github.io/) index
- iLEAPP's [public-corpus index](https://github.com/abrignoni/iLEAPP/blob/main/admin/docs/testing/public_corpus_images.md)
- CTF archives: Magnet, Cellebrite, Belkasoft, Hexordia/MSAB, FCSC, Hackvent
- academic repositories (Zenodo, figshare, IEEE DataPort, Kaggle, Hugging Face): none hold iTunes/Finder backups
- open-source fixtures

### 3.1 Real iTunes/Finder backups

How each one was checked:
- **Read:** we opened the backup's own `Info.plist` / `Manifest.plist`.
- **Listed:** confirmed from the archive's file listing plus the creator's documentation.
- **Reported:** described by others only; we haven't checked it.

The table lists only the backup passwords that the creators published.

| Corpus key | iOS (build) | Device | Made by | Encrypted / password | Size and where | Notes | Checked |
|---|---|---|---|---|---|---|---|
| `pub-hickman-13.3.1` | 13.3.1 | iPhone SE (iPhone8,4) | Mac | yes / `mypassword123` | ~0.40 GB zip inside Digital Corpora `ios_13_3_1.zip` (8.9 GB) | Same phone as the next two | Listed |
| `pub-hickman-13.4.1` | 13.4.1 | same phone | Mac | yes / `mypassword123` | ~0.42 GB zip inside `ios_13_4_1.zip` (9.6 GB) | | Listed |
| `pub-hickman-14.3` | 14.3 | same phone | Finder | yes / `mypassword123` | 471 MB on its own (MediaFire) | 42 apps, 4,525 files | Read |
| `pub-magnet21-14.4` | 14.4 | iPhone 8 (iPhone10,4) | Mac | yes / stored in Magnet's own published keychain export | 153 MB, 2,135 files, inside an 81 GB macOS image | Same phone as Magnet's 2021 full-file-system image | Read |
| `pub-cellebrite21-marsha` | 14.x | iPhone X | iTunes (Microsoft Store), Windows | **no** | Inside `sda Image.E01` in a ~44 GB 5-part zip (Google Drive) | The only data-rich *unencrypted* real backup; needs the E01 disk image mounted; matches Marsha's full-file-system image | Listed |
| `pub-hickman-15.3.1` | 15.3.1 (19D52) | iPhone 8 (iPhone10,4) | Finder | yes / `MyBackup123` | 497 MB on its own, Digital Corpora | 54 apps | Read |
| `pub-fcsc25-16.0` | 16.0 (20A362) | iPhone 11 Pro (iPhone12,3) | iTunes 12.10.5 | yes / not published | 31 MB, Hackropole | The only real backup under an open licence (etalab-2.0). Use it for metadata, keybag and "unknown password" tests | Read |
| `pub-hickman-16.1.2` | 16.1.2 (20B110) | iPhone 11 (iPhone12,1) | iTunes for Windows 12.13.1.3 | yes / `MyPassword123` | 1.59 GB; the first file in `iOS_16_Public_Image.tar.gz` (20 GB) | 56 apps | Read |
| `pub-hickman-17.3` | 17.3 (21D50) | the same iPhone 11, upgraded | Finder | yes / `MyPassword123` | 2.29 GB; the first file in `iOS_17_Public_Image.tar.gz` (22 GB) | 57 apps; carries on from the 16.1.2 phone | Read |

**Not usable, or too small to matter**

- **BelkaCTF #6 laptop:** an iOS 16.x Windows backup, but the archive password was never published.
- **CNIT 121 iPad backup:** iOS 7, `Manifest.mbdb`, unencrypted, no licence. Useful only as the "too old" detection case.
- **Hackvent 2020:** iOS 9.3.6, `Manifest.mbdb`, encrypted; the password was never published.
- **`rickmark/generic-ios-backups`:** iOS 13.3–14.0β, but the phones are empty and there's no licence.
- **MVT's `tests/artifacts/ios_backup`:** a partial iOS 14.3 backup under the MVT licence.

**Built-in answer keys.** Each of Hickman's PDFs includes a timestamped log of everything done on the phone: every message, call, photo and app action. We can turn those logs into spot checks.

### 3.2 Full-file-system images

These images don't contain a backup, but they do contain the same databases.

| iOS | Source | Device | Size |
|---|---|---|---|
| 12.4 | Magnet MVS 2020 | A12 iPhone | 12.8 GB |
| 13.3.1, 13.4.1, 14.2, 14.3 | Hickman | iPhone SE | 16–22 GB each |
| 14.4 | Magnet MVS 2021 (GrayKey) | iPhone 8 | 5.8 GB |
| 14.x | Cellebrite 2021 (Beth, Marsha) | 2× iPhone X | 8.3 / ~28 GB |
| 15.0.2 | Magnet MUS 2022 | iPhone 8 | 4.7 GB |
| 15.3.1 | Hickman | iPhone 8 | ~16.7 GB |
| 16.1.1 | Magnet MVS 2023 (CFReDS wrongly labels it 14.7.1) | A14 iPhone | 10.7 GB |
| 16.1.2, 17.3 | Hickman | iPhone 11 | inside the 20 / 22 GB archives |
| 16.3 | BelkaCTF #6 | iPhone 8 | 2.2 GB |
| 16.5 | Cellebrite 2023 (Abe, Felix) | iPhone X, iPhone 8 Plus | 24 / 9 GB |
| 16.5.1 | MVS 2024 (Hexordia) | iPhone 14 | 32 GB |
| 17.5.1 | Cellebrite 2024 (Otto); *Digital Forensics Cookbook* (Packt) | iPhone 11 Pro; unknown | 41 GB; 5.1 GB |
| 17.6.1 | Cellebrite 2024 (Felix) | iPhone 12 mini | 22 GB |
| 18.0 | MVS 2025 and MVS 2026 (Hexordia) | iPhone 14 Plus | 11.5 / 10.4 GB |
| 18.3.2 | Cellebrite 2025 (Dexter) | iPhone 16 | 70 GB |
| 18.7 | MSAB Digital Summit 2026 (Hexordia) | iPhone 12 | 50 GB |

### 3.3 Open-source fixtures, generators and references

| Project | Licence | What it gives us |
|---|---|---|
| [SecurityRonin/ios-backup-forensic](https://github.com/SecurityRonin/ios-backup-forensic): `tools/mint_encrypted_backup.py`, `tests/data` | Apache-2.0 | Writes deterministic encrypted and plain backup **containers**, including the keybag, class keys, `ManifestKey` and per-file keys, plus deliberately malformed variants. The file contents are placeholders. **This is the best starting point for our container writer.** |
| [novkostya/ios-backup-crypt](https://github.com/novkostya/ios-backup-crypt) | MIT | A Go backup builder, tested against `iphone_backup_decrypt` |
| messagecrate `chat-db-fixture` ([PR #1988](https://github.com/messagecrate/message-crate/pull/1988)) | MIT OR Apache-2.0 | Rust: a real `chat.db`, AddressBook and one photo, packaged as plain and encrypted backups |
| [jasonrowlandAG/Salvage](https://github.com/jasonrowlandAG/Salvage) `ios_fixtures.py` | MIT | Cut-down real schemas, plus builders for `attributedBody` and the Notes protobuf |
| [discordwell/green2blue](https://github.com/discordwell/green2blue) | MIT | Inserts rows into the real `sms.db` inside real backups, then restores them to devices. Prior art for our restore experiment (§7.4) |
| [apple_cloud_notes_parser](https://github.com/threeplanetssoftware/apple_cloud_notes_parser) | MIT | The Notes protobuf definition, the columns that identify each Notes version from iOS 11 to 26, and test blobs |
| [osxphotos](https://github.com/RhetTbull/osxphotos) | MIT | About 50 macOS Photos libraries (macOS 10.12 → 27 beta) and a table of Photos model versions |
| [iphonebackuptools](https://github.com/richinfante/iphonebackuptools) | MIT | `Manifest.plist` and `sms.db` schemas for iOS 6–11 |
| [AppleDB](https://github.com/littlebyteorg/appledb) | MIT | Maps builds ↔ versions ↔ devices |
| iLEAPP | MIT (code) | Shows which queries change with each iOS version. Its test data comes from third parties, so download it rather than copying it |
| imessage-exporter, pymobiledevice3, crabapple | GPL-3 | For reading only; we don't copy them |
| mac4n6/APOLLO | BSD-style or GPL-3 | SQL for each iOS version from 8 to 14; for reading |
| mvt | MVT License 1.1 | Download only |

## 4. Gaps

- **iOS 10, 11, 12:** no real public backup at all. 12.4 exists only as a full-file-system image.
- **iOS 18, 26, 27:** no real backup. 18.x exists only as full-file-system images, and there's nothing at all for 26 or 27.
- **Unencrypted:** one data-rich example (`pub-cellebrite21-marsha`). No phone has both an encrypted and an unencrypted backup.
- **Depth:** the longest history is about a year (Hickman's iPhone SE, 13.3.1 → 14.3). Every public phone was factory-reset and then filled with data over a few weeks. None has years of migrated data, realistic volume, the effects of iCloud settings, or a move from one phone to another.
- **Devices and hosts:** no iPad backups in our range, and no backups made with Apple Devices for Windows.
- **Terms:** the data is offered for research and testing, and the images contain real test-account identifiers. That's fine for validation, but not for redistribution or screenshots.

**Conclusion:** use the public data to validate, and build everything else ourselves.

## 5. Design: four layers

| Layer | What | What it gives us | Where it's stored |
|---|---|---|---|
| **L1 `pub`** | The real public backups in §3.1 | Real containers and real data for iOS 13.3–17.3, from Mac and Windows | Downloaded at test time, pinned by hash, cached |
| **L2 `ffs`** | Backups rebuilt from the full-file-system images in §3.2 | Real Apple-written databases for versions with no public backup (12.4, 16.5, 17.5–17.6, 18.0–18.7) | Built locally from cached downloads; private cache |
| **L3 `ref`** | Backups from our own reference iPhones | Real backups for 18.x, 26, 27 and every future release; encrypted and unencrypted pairs; Finder, iTunes and Apple Devices; real migration over years | Private object storage |
| **L4 `syn`** | Output of our generator | Every version from 10 to 27, every variant and edge case, any volume, exact answer keys. Safe for screenshots and the public repo | Generated on demand; tiny samples may be committed |

**How the layers check each other**

- **L1–L3 feed L4.** They supply schemas and "shape" statistics (§6.2). L4 never copies their rows.
- **L1 checks L2.** L1 has a full-file-system image and a backup of the **same phone at the same moment** for Hickman 13.3.1, 13.4.1, 15.3.1, 16.1.2 and 17.3, and for Magnet 14.4. We run the L2 converter on the image and diff the result against the real backup. That measures how faithful the converter is before we rely on it for 12.4 and 18.x.
- **L3 checks L4.** We restore generated backups onto real phones (§7.4), and independent parsers (iLEAPP, mvt) read the generated output.

### L2 converter outline

1. **Map file-system paths to backup domains.** Typical cases:
   - `HomeDomain`, `MediaDomain` and `CameraRollDomain` are rooted at `/private/var/mobile/`.
   - `AppDomain-<bundle id>` points to `/private/var/mobile/Containers/Data/Application/<UUID>/`. The bundle id comes from `.com.apple.mobile_container_manager.metadata.plist`.
   - `AppDomainGroup-<group id>` points to `…/Containers/Shared/AppGroup/<UUID>/`.

   Work out the exact mapping, and which files Apple's backup process actually includes, **from the same-phone image/backup pairs** rather than writing it by hand.
2. **Package the result.** Write plain and encrypted versions with the L4 container writer.
3. **Label every L2 item** `container: synthetic, payloads: real`.

## 6. The synthetic generator (L4)

### 6.1 Components

```
corpus/
  schemas/<ios>/<db>.sql, <db>.meta.json   harvested table definitions, user_version, Core Data entity map — never rows
  persona/                                 life script, cast, content pools (our own, CC0)
  writers/                                 one per data type, version-aware
  container/                               Manifest.db / Manifest.mbdb, plists, keybag and encryption, folder layout
  variants/                                host, location, iCloud flags, edge-case mutators
  answer_key/                              writes the expected outputs
  harvest/                                 schema harvester (L1–L3 + iOS Simulator)
  fetch/                                   L1/L2 downloads, range and stream extraction, hash checks
  cli.py
```

```bash
corpus generate --persona dana --snapshot 2024-09-20 --ios 18.0 --volume typical \
  --host finder --encrypt --password test1234 --iterations fast --seed 42 --out build/corpus/
```

### 6.2 Version accuracy: harvested, not hand-written

- **What the harvester records.** It reads any backup, full-file-system image or Simulator data folder and writes, for each database:
  - the `sqlite_master` SQL
  - `PRAGMA user_version`
  - columns, indexes and triggers
  - Core Data `Z_PRIMARYKEY` entity numbers
  - "shape" statistics per column: null rate, value types, and blob signatures such as `bplist00`, `streamtyped` and gzip

  It never records row values.
- **Sources, best first:**
  1. L3 (18.x, 26, 27, and every new release)
  2. L1 (13.3.1–17.3)
  3. L2 (12.4, 14.x, 15.0.2, 16.x, 17.5–17.6, 18.0–18.7)
  4. Published table definitions for iOS 10–11 (iphonebackuptools, APOLLO)
  5. Xcode iOS Simulator runtimes, last. They produce `sms.db`, Photos, AddressBook, Safari, Health and Calendar, but not Notes, Calls or Voicemail, and may differ from real devices.
- **Versions with no harvested schema** get the nearest older schema plus the documented changes. Those items are marked `confidence: interpolated`.
- **Schema drift report.** `corpus harvest diff 18.7 26.0` lists the tables and columns added or removed in each database. This is the core of the annual refresh (§9).
- **Check columns, not version numbers.** Schemas change independently of OS releases; imessage-exporter's maintainers note this explicitly. So writers check which columns exist, the same way `ios_backup_core/schema.py` already does.

### 6.3 The persona and life script

The persona is a fictional person (working name "Dana"). Their 2016–2026 history is written as a timeline:

| Date | Event |
|---|---|
| 2016-09 | iPhone 7 on iOS 10.0, new Apple ID |
| 2017-06 | Backs up to a Windows PC with iTunes (unencrypted) |
| 2018-11 | Switches to an iPhone XS by restoring from an encrypted backup; iOS 12.1 |
| 2020-10 | iPhone 12 on iOS 14.1; backups move to a Mac (Finder) |
| 2021-02 | Turns on Messages in iCloud (in one variant) |
| 2022-09 | iPhone 14 on iOS 16.0 |
| 2024-09 | iPhone 16 on iOS 18.0; RCS becomes available |
| 2025-09 | iOS 26 |
| 2026-09 | iOS 27 |

Along the way there are point updates and life events: moving house, trips (new time zones, photos with GPS), a job change (new contacts and a work group chat), a family chat renamed many times, deleted contacts, a number change, and a lost phone that gets replaced.

**Feature gates.** A record can only use features that existed on the iOS version it was created on:

| iOS | Messages | Other data types |
|---|---|---|
| 10 | Tapbacks, effects, stickers and iMessage apps, Digital Touch, handwriting | |
| 11 | Apple Cash (11.2), Messages in iCloud (11.4) | |
| 12 | Memoji | |
| 14 | Inline replies, mentions, group photos | Photos table renamed from `ZGENERICASSET` to `ZASSET` |
| 16 | Edit, unsend, mark as unread | Photos shared library (16.1) |
| 17 | New stickers, Check In, transcripts of audio messages | Live Voicemail, Contact Posters |
| 18 | RCS, Send Later, text formatting and effects, any-emoji tapbacks, Genmoji (18.2), messages via satellite | Photos redesign, call recording (18.1) |
| 26 | Polls, chat backgrounds, screening of unknown senders | Call Screening, Hold Assist |
| 27 | to be harvested | to be harvested |

Confirm each feature's effect on the schema with the harvester. Don't trust this table on its own.

**Snapshots.** The life script marks backup events. The generator can produce a backup at any snapshot date, in that era's format, containing everything up to that date. That gives a set of "old backups on disk" that all share one consistent history. It also makes a **persistence check** possible: any record created before snapshot S, and not later deleted, must come out identical from every later snapshot. That catches version-specific parsing bugs without hand-written expectations.

**Content**

- **Fictional identifiers:**
  - phone numbers in the US NANP 555-0100–0199 range and the UK Ofcom drama range (07700 900xxx)
  - email addresses at `example.com`, `.org` and `.net`
  - real public places for locations
- **Text:** our own conversation scripts, hand-written or LLM-assisted, then reviewed and committed as CC0, so threads read naturally in screenshots. Bulk filler comes from templates using the same cast.
- **Media:**
  - our own photos, or generated images, with EXIF time and GPS written by the generator
  - text-to-speech audio for voicemail, voice memos and audio messages
  - small valid placeholder files for volume runs, and full-size media in a "realistic size" mode

**Volume profiles** (targets, to calibrate against L3):

| Profile | Used for | Messages | Photos | Contacts | Calls | Notes | Backup size |
|---|---|---|---|---|---|---|---|
| `tiny` | PR tier | ~200 | ~20 | ~25 | ~50 | ~10 | < 5 MB |
| `typical` | nightly runs, screenshots | ~100k | ~20k | ~600 | ~12k | ~300 | ~1 GB with placeholders; tens of GB with real-size media |
| `heavy` | performance | 400k+ | 60k+ | ~2k | ~30k | ~1k | 150 GB+ (sparse files or real-size media) |

### 6.4 Container and variants

- **`Manifest.db`** has real `Files` rows. The fileID is SHA-1 of `domain-relativePath`, and each row has an NSKeyedArchiver `MBFile` blob holding size, mode, modification time and protection class. There's also a `Properties` table. For the pre-iOS 10 case there's a separate `Manifest.mbdb` writer.
- **Plists per era and host.** `Info.plist`, `Manifest.plist` and `Status.plist` match the era and the host software. For example, `iTunes Version` appears only in iTunes-made backups, and Status `Version` is 3.3.
- **Encryption**
  - **What it writes:** keybag (VERS 4 or 5, as a parameter), class keys, `ManifestKey`, wrapped per-file keys, AES-256-CBC and padding.
  - **Where it comes from:** start from SecurityRonin's mint script (Apache-2.0, keep its notice), and check every output by decrypting it with `iphone_backup_decrypt`.
  - **Iteration counts:** `fast` (around 1,000) for CI, and `real` (DPIC 10,000,000 / ITER 10,000).
  - **Older scheme:** backups from the 10.0–10.1 era and earlier use the single-PBKDF2 scheme.
- **Variants** (can be applied to any generated backup):
  - **host:** `finder`, `itunes-mac`, `itunes-win-desktop`, `itunes-win-store`, `apple-devices-win`, `pymobiledevice3`
  - **location:** each default path, a custom path, an external drive, an archived copy name
  - **iCloud:** `messages_in_icloud`, `icloud_photos_optimize`, `icloud_notes`
  - **state:**
    - `interrupted`, `partial_copy`, `missing_files`, `corrupt_manifest`
    - `wal_pending`: recent rows exist only in `-wal`
    - `deleted_rows`: for the recovery feature
    - `wrong_password`
  - **multi:** several devices and iPads in one backup folder; one device with several snapshots
- **Determinism**
  - The seed drives every random choice, including IVs and keys.
  - The SQLite page size is fixed and rows are written in a set order.
  - `VACUUM` runs before packaging, except for the `wal_pending` and `deleted_rows` variants.

### 6.5 Answer keys

Each item comes with its expected output, shaped like the sidecar's JSON-RPC results, so tests can compare directly:

```
<item>/
  item.json            id, layer, iOS version, build, product_type, host, encrypted, password,
                       persona snapshot, generator version, seed, confidence, provenance, licence
  backup/<UDID>/…      the backup itself (L4), or a pointer to the cache (L1–L3)
  expected/
    get_backup_stats.json
    list_contacts.json
    list_conversations.json
    get_messages/<conversation>.json
    list_calls.json
    list_voicemails.json
    list_notes.json
    list_photos.json
    list_browser_history.json
    recover_messages.json
    absent.json        data that must be reported as unavailable, with a reason code
                       (e.g. health → encrypted_only)
  facts.yaml           hand-picked spot checks (L1)
```

The generator produces `expected/` from the life script, not by running OpenExtract, so the answer key is independent of the code it tests.

### 6.6 Checking the generator itself

1. **Schema diff:** no unexplained differences from the harvested real schema for the same version.
2. **Shape diff:** per-column null rates and blob types fall within tolerance of real data from the same era.
3. **Independent parsers:** iLEAPP and mvt (run as external tools) read generated backups without errors and report the same counts.
4. **Decryption check:** `iphone_backup_decrypt` decrypts every encrypted variant.
5. **Restore test:** iOS accepts a generated backup and keeps the data (§7.4).

## 7. Reference devices (L3)

### 7.1 Fleet

| Role | Example device | iOS | Why |
|---|---|---|---|
| Frozen on 16 | iPhone 8 or X | final 16.7.x | the last version those models get |
| Frozen on 18 | iPhone XS or XR | final 18.x | the last version those models get |
| Current | iPhone 11 or newer | latest release | updated on release day |
| Long-running | any model that supports the latest iOS | upgraded every September, never erased | real migration history over years |
| Beta (optional) | a spare | developer betas, June–September | early warning |
| Older versions (when they turn up) | used phones still on iOS 10–15 | whatever they're on | the only way to get real backups from old versions, since Apple no longer lets anyone install them |

- **Check before buying** which iOS version is the last for each model.
- **Reusing frozen phones:** "Erase All Content and Settings" doesn't change the iOS version, so frozen phones can be wiped and refilled.
- **Activation risk:** very old versions may no longer activate. Test one phone before buying more.

### 7.2 Accounts and lines

- One or two Apple IDs used only for the persona. A second "other side" Apple ID signed in on a Mac.
- A prepaid SIM for SMS, MMS, calls and voicemail.
- Optional: an SMS/voice API account (Twilio or similar) to send SMS/MMS and leave voicemails from scripts.

### 7.3 Filling the phones

Run the same life script as L4 on the devices, and log each step as it happens. The log becomes the answer key.

- **iMessages:** AppleScript in Messages on the "other side" Mac, for volume, with attachments.
- **SMS/MMS, calls, voicemail:** the SMS/voice API or a second phone.
- **Contacts:** import vCards.
- **Notes and Calendar:** create them on the device, in both "On My iPhone" and iCloud accounts.
- **Health:** a Shortcuts automation using "Log Health Sample", or an Apple Watch.
- **Photos:** take them on the device, or save them from Messages or AirDrop. Photos synced from a computer aren't included in backups, and that's a test case in itself.
- **Backups after each session:** Finder (Mac), iTunes or Apple Devices (Windows), and `pymobiledevice3 backup2` (scriptable, and can switch encryption on and off). Make an encrypted and an unencrypted backup each time. `Info.plist` is written by the host software, so real Finder and iTunes backups are needed, not just pymobiledevice3 ones.
- **Settle the iCloud question on a real device.** Record what Messages in iCloud and iCloud Photos actually leave in a local backup. Apple's documentation and iMazing/Elcomsoft disagree, and the answer goes into this doc.

### 7.4 Restore experiment (high value, not yet proven)

1. Generate an iOS N-era backup containing the full 2016 → N history at `typical` volume.
2. Restore it onto a reference phone running iOS N or later, using Finder or `pymobiledevice3 backup2 restore`. Use the persona Apple ID, with Messages in iCloud turned off.
3. Let iOS boot and migrate the data, then spot-check it on the device.
4. Back the phone up with Finder, then harvest and diff.

**Go/no-go:** the data survives the restore and shows up on the device.

**Payoff:** genuine Apple-written backups carrying ten years of our fictional history, and proof that the generator is realistic.

**Prior art:**
- green2blue restores real backups after injecting rows.
- TrollRestore shows that iOS accepts crafted restores.

**Risks:**
- iOS may drop databases it considers inconsistent (Core Data metadata).
- The restore may need matching encryption settings.

### 7.5 Storage

Reference backups contain our devices' serial numbers and IMEIs. Encrypted ones also contain keychain tokens for the persona's Apple ID. So:
- Keep them in private, access-controlled storage, never in git.
- Sign the persona out everywhere before sharing any of it.

## 8. Test harness and assertions

### 8.1 Where tests live

- **`ios-backup-core/tests/corpus/`:** library-level tests over the corpus, one extractor at a time.
- **`openextract/python/tests/corpus/`:** end-to-end tests.
  - **How they run:** they start the real sidecar (`python/main.py`) and drive it over JSON-RPC with unique request IDs. That also tests that IPC is stable.
  - **Methods covered:** `list_backups`, `open_backup`, `validate_password`, `list_conversations`, `get_messages`, `get_attachment`, `list_contacts`, `list_calls`, `list_voicemails`, `list_notes`, `list_photos`, `list_browser_history`, `recover_messages`, `get_backup_stats` and the `export_*` methods.
- **A pytest plugin selects items by tier and layer**, e.g. `pytest -m "corpus and tier_pr"`. Items whose data isn't available locally are skipped with a stated reason, never failed.

### 8.2 Kinds of assertion

| Kind | Applies to | What it checks |
|---|---|---|
| Answer key | L4, L3 | Exact match to `expected/`, after normalizing: sorted, UTC ISO timestamps, volatile fields ignored |
| Spot facts | L1 | 20–50 hand-picked facts per public image, taken from the creator's activity log (e.g. "message with text X sent at time T with one picture") |
| Invariants | all | No unhandled sidecar error. Counts per type equal direct SQL counts. Every timestamp falls between device activation and the backup date. Every attachment either resolves or is reported missing with a reason. Every handle resolves to a contact or a formatted number. Export round-trips |
| Persistence | L4 snapshots, L3 long-running phone | Records from earlier snapshots come out identical from later ones |
| Absence | all | Data that only exists in encrypted backups is reported that way in unencrypted ones. Attachments moved to iCloud are reported, not silently dropped |
| Error messages | L4 variants | Wrong password, unknown password, `Manifest.mbdb`, interrupted backup, corrupt manifest and denied Full Disk Access each produce the specific user-facing message, not a crash |
| Fingerprints | L1, L2, L3 | The first approved output is stored in git as counts plus hashes of normalized records, with no content. Any later diff needs review |
| Performance | `heavy` | Time to open, peak memory, time to first page, export throughput, and decrypt time at real iteration counts. Tracked as trends against budgets |

### 8.3 Screenshots

A curated `showcase` snapshot from L4 (good-looking threads and photos) feeds the website and docs screenshots. L1 and L2 data never appears in screenshots.

## 9. Cadence and infrastructure

| Tier | When | Runner | What runs | Time budget |
|---|---|---|---|---|
| T0 PR | every PR | Ubuntu (the existing `ci.yml`) | `tiny` L4 for each iOS profile, plain and encrypted (`fast`), plus the error-message variants | < 5 min |
| T1 Nightly | nightly | macOS and Windows (GitHub-hosted) | The full L4 variant matrix at `typical`, one encrypted item at `real` iterations, every host and location | < 60 min |
| T2 Weekly | weekly | self-hosted Mac with the corpus cached | L1, L2, the latest L3, and `heavy` performance runs | hours |
| T3 Release | before each release | — | T0–T2 and the latest L3 must all pass | — |
| T4 iOS cycle | June (beta), September (release), and each point release | reference devices | New backups, harvest and schema diff, a new L4 profile, and extractor fixes before most users upgrade | — |

### Infrastructure

- **Manifests:** a public `corpus/manifest.yaml` (URLs, hashes, fetch method, licence notes) and a private manifest for L3.
- **Cache:**
  - L1 is about 6 GB of backup portions.
  - The raw L2 downloads are about 400 GB, but the rebuilt backups are only a few GB. Build them once, keep the results and delete the raw downloads.
- **Storage:** a private bucket for L3 and the rebuilt L2 items (tens of GB).
- **Self-hosted runner:** a Mac mini that also hosts the reference phones, for scheduled `pymobiledevice3` backups.
- **Rough costs (estimates):**
  - used phones: $100–300 each
  - prepaid line: $10–25 a month
  - SMS/voice API: a few dollars a month
  - storage: $5–20 a month

## 10. Data handling rules

1. **The public repo** holds code, harvested schemas and statistics (no rows), manifests, our persona content (CC0) and tiny generated fixtures. Nothing else.
2. **L1 and L2 data:**
   - Download from the creator's location, check the hash, and keep it in a local or private cache.
   - Link to the creators' pages.
   - Follow their requests. Hickman asks people to link to his blog posts and not to download cloud data from the apps in his images.
   - The suite must never use credentials or tokens found in any image. Run tests with networking off where possible.
3. **No L1, L2 or L3 content** goes into screenshots, bug reports or issue comments. Fingerprints only.
4. **Ask Josh Hickman** before quoting his images in public docs. Also ask whether he plans iOS 18 or 26 images.
5. **L3 backups are treated as secrets** (§7.5).
6. **Optional, later:** a "copy schema report" button in OpenExtract that users click themselves, opt-in. It copies table definitions and row counts only, with no content, for attaching to bug reports. That would give us schema coverage from real phones with ten years of history, without any telemetry.

## 11. Roadmap

| Phase | Deliverables | Done when |
|---|---|---|
| **0. Foundations** | Corpus manifest format; fetch tool (range/stream extraction and hash check); a test driver that talks to the sidecar over JSON-RPC; invariants; a format for spot facts | `pub-hickman-15.3.1` passes the invariants and 20 spot facts in a weekly job |
| **1. Generator MVP** | Container writer (plain and encrypted, `fast` and `real` iterations) for the iOS 17 era; Messages and Contacts writers; a one-year persona; answer keys; the schema harvester run over L1 and the Simulator | T0 runs `syn` for iOS 17 and 26 for Messages and Contacts, and the output decrypts with `iphone_backup_decrypt` and opens in iLEAPP |
| **2. Breadth** | Writers for every data type; profiles for iOS 13–27 from harvested schemas; host, location, iCloud and state variants; the ten-year persona at `typical`; T1 on macOS and Windows; the L2 converter, calibrated on same-phone pairs; L2 items for 12.4, 16.5, 17.5 and 18.x | The coverage matrix (Appendix D) is green for iOS 13–27 |
| **3. Reference devices** (in parallel; needs hardware) | The device fleet, accounts, the life-script runbook and automation; the first L3 set (frozen on 16, frozen on 18, current); the Messages-in-iCloud test; a go/no-go on the restore experiment | L3 items for 18.x and current iOS run in T2 |
| **4. Depth and old versions** | Profiles for iOS 10–12 (`Manifest.mbdb` detection, pre-10.2 encryption, schemas from references and any old devices we can find); performance budgets for `heavy`; the showcase persona and screenshot pipeline; the annual runbook | The first full yearly iOS cycle has been done end to end |

### Phase 0 results

**What was built:**
- [`corpus/`](../corpus/README.md): the manifest of all nine public backups, the fetch tool, spot facts and known issues.
- [`python/tests/corpus/`](../python/tests/corpus/): the sidecar JSON-RPC driver, an independent raw-database reader, the invariants, fact checks, and unit tests for the tooling.
- `.github/workflows/corpus-weekly.yml`: the weekly job.

**Exit criterion: met.** `pub-hickman-15.3.1` passes every invariant and all 25 spot facts, with one known issue recorded as a strict xfail.

**Getting there meant fixing real bugs** that the first run exposed on this real iOS 15.3.1 backup. Each fix has its own regression test.

| # | Bug | Effect for users | Fixed in |
|---|---|---|---|
| 1 | CallHistory stores all-digit addresses (short codes) as INTEGER, and contact lookup assumed text | **Call history failed to load** | ios-backup-core `contacts`, `calls` |
| 2 | FaceTime video vs audio was read from `ZIS_VIDEO`, which iOS 15 doesn't have | Every FaceTime video call showed as audio | ios-backup-core `calls` (use `ZCALLTYPE` 8/16) |
| 3 | Outgoing call status came from `ZANSWERED`, which is always 0 on outgoing calls | Connected outgoing calls showed as "missed" | ios-backup-core `calls` |
| 4 | Photos.sqlite is a WAL database shipped without `-shm`; the read-only open failed on the first query, and the fallback never ran | No albums | ios-backup-core `photos` |
| 5 | `ZASSET` renamed columns in iOS 15 (`ZMODIFICATIONDATE`, `ZAVALANCHEUUID`) | **Photo listing failed**; the app quietly fell back to a DCIM scan with no dates, places or albums | ios-backup-core `photos`; openextract `photos.py` now reports `fallback_reason` |
| 6 | Notes read the creation date from `ZCREATIONDATE`; iOS 15 uses `ZCREATIONDATE3` | Notes had no creation date | ios-backup-core `notes` |
| 7 | Safari's `domain_expansion` was treated as a domain, but it holds a label such as `nhl` | Wrong domain shown for most visits | ios-backup-core `browser_history` |
| 8 | Stats counted every chat as a group (`chat.group_id` is set on all chats) and counted empty chats | Dashboard said 15 group chats and 0 one-on-one; the real numbers were 0 and 15 | openextract `stats.py` |
| 9 | iOS 13 and earlier call the assets table `ZGENERICASSET`, not `ZASSET` (found on 13.4.1) | **No photo dates, albums or stats on iOS 13 backups** | ios-backup-core `photos`; openextract `photos.py`, `stats.py` |

**Other public backups.** All six backups that can be fetched without manual steps were fetched and run:
- **Fetch paths:** zip members by range request (13.3.1, 13.4.1), tar.gz streaming (16.1.2, 17.3) and `.tar.xz` (FCSC). The two with creator-published hashes (16.1.2, 17.3) matched them.
- **13.3.1, 13.4.1, 16.1.2 and 17.3** pass every invariant once the fixes above are in. They have no facts files yet, so they aren't in the weekly tier.
- **FCSC 16.0:** its password isn't published, so only listing and password handling can be tested.

**Known issue, needs a product decision:** shared-album photos whose originals aren't in the backup (only their thumbnails are) are counted in the photo total but left out of the list. Counted vs listed:

| Backup | Counted | Listed |
|---|---|---|
| 15.3.1 | 231 | 206 |
| 16.1.2 | 387 | 347 |
| 17.3 | 567 | 523 |

See `corpus/known_issues.json`.

**Fetch tool hardening found by using it on the real archives:**
- Long range and stream downloads now reconnect and resume after dropped connections.
- `.tar.xz` items give a clear error on Python builds without lzma.

## 12. Decisions needed

1. **Hardware budget:** do we buy 3–4 used iPhones and a prepaid line?
2. **Where the generator lives.**
   - **Recommendation:** in `ios-backup-core`, as dev-only tooling that isn't shipped in the wheel. Schema knowledge and the extractors change together. OpenExtract's end-to-end tests would use it through the existing sibling checkout.
   - **Alternative:** a separate `backup-corpus` repo.
3. **Private storage:** which provider, and who gets access.
4. **A self-hosted Mac runner:** it's needed for T2 and for automating the devices.
5. **Persona text:** hand-written, or LLM-assisted (reviewed and committed as CC0).
6. **Josh Hickman:** do we contact him, for permission and to ask about future images?

## 13. Risks

| Risk | Mitigation |
|---|---|
| Simulator schemas differ from real devices | The Simulator is the lowest-priority schema source, replaced by L3 data as it arrives |
| The restore experiment fails | L4 is still checked by schema and shape diffs and by independent parsers. Depth then builds up over time on the long-running phone |
| Old iOS versions can't be activated or bought | Accept synthetic-only coverage for 10–12, marked `confidence: interpolated` |
| Public datasets disappear (MediaFire and Drive links) | Everything is pinned by hash. Tests skip with a clear reason. Keep a private cached copy where the terms allow it |
| Apple changes the backup format or encryption | The June beta testing in T4 catches it |
| Sources disagree about what iCloud-synced data leaves in a backup | Settle it with the L3 test and record the answer here |
| Download size and time in CI | L1 and L2 run only in T2, on the self-hosted runner with its cache |

---

## Appendix A: Fetch notes and hashes

Digital Corpora files are plain HTTPS on S3 and support range requests, so we only download the parts we need. Where a SHA-256 is given below, it's the value published in the creator's PDF. For the others, compute the hash on the first fetch and pin it.

| Item | How to fetch | SHA-256 |
|---|---|---|
| `pub-hickman-13.3.1`, `-13.4.1` | Read the central directory of `corpora/mobile/ios_13_{3,4}_1/ios_13_{3,4}_1.zip`, download only the `iOS 13.x.1 Extraction/iTunes Backup/c623fbd7e91b041e07a68f8523f53a35973e475d.zip` entry, and decompress it | 13.3.1: `9022c2e890ce18117bc566ed919dd0ead487dcd61ead00f8458f1b5808bf8c65`; 13.4.1: `2133e449c4db41f6bb4e655dcf22dfc6eaa6fe428f36b969cae588d5dc0b47fa` (pinned on first fetch, 2026-10-10) |
| `pub-hickman-14.3` | MediaFire folder linked from [thebinaryhick.blog](https://thebinaryhick.blog/public_images/), `iOS 14.3/iTunes Backup/c623fbd7…475d.zip`. May need a manual download | pin on first fetch |
| `pub-magnet21-14.4` | `corpora/scenarios/magnet/2021 CTF - MacOS.zip` stores its files uncompressed, so fetch each file under `Users/eliflatt/Library/Application Support/MobileSync/Backup/518e8d766f9b3e76db216f35fdb6b0604e50f61b/` with range requests. The backup password is in the keychain export `…_passwords.txt` (service `BackupAgent`) inside `2021 CTF - iOS.zip` | pin on first fetch |
| `pub-cellebrite21-marsha` | The Google Drive folder from Cellebrite's CTF 2021 page (5-part zip; zip password published in Cellebrite's `ZIP_Password.txt`). Mount `sda Image.E01` with libewf and copy `C:\Users\marsh\Apple\MobileSync\Backup\efa74738…` | pin on first fetch |
| `pub-hickman-15.3.1` | Download `corpora/mobile/android_13/ios_15_3_1/c50d35ac85f428883e3b6fa3893599da85f708ea.zip` directly | `8a59db97a99db5ceb658221139adfb0ff2e2dca76f7a8a37958a6a76b609ae19` |
| `pub-fcsc25-16.0` | `https://hackropole.fr/filer/fcsc2025-forensics-iforensics/public_filer/backup.tar.xz` (needs a Python built with lzma) | `f7e00e4979573e09f582bebb2a64d5daa0ad6151ca7f6971beabbfaa81b400ce` (pinned on first fetch, 2026-10-10) |
| `pub-hickman-16.1.2` | Stream-decompress `corpora/mobile/iOS16/iOS_16_Public_Image.tar.gz` and stop after the first tar entry, `00008030-001259123E50802E.zip` (1.59 GB) | `b7baa56a69b1cd7d33a29537fe54e5c2f90e9e55a37f56a6b3fa9fc7fc5d6d07` |
| `pub-hickman-17.3` | Same method with `corpora/mobile/iOS17/iOS_17_Public_Image.tar.gz` (first entry, 2.29 GB) | `acea6302f7b447dcdf1e845549917030bb0763a9897a2a3aa930c53754499e0b` |

**Full-file-system archives (L2).** Cellebrite (2023, 2024, 2025) and Belkasoft (BelkaCTF #6) published the passwords for their CTF archives on the challenge pages. Record them in `corpus/manifest.yaml` when we add those items, and check them on the first fetch. Magnet and Hexordia archives have no password.

**Tools.** The survey used remote zip central-directory reads, nested-zip entry extraction and tar.gz streaming. All of these worked and should become `corpus/fetch/`.

## Appendix B: Where each data type lives in a backup

This is taken from the `ios-backup-core` extractors, including the feature branches.

| Data | Domain | Relative path |
|---|---|---|
| Messages | `HomeDomain` | `Library/SMS/sms.db` (+ `-wal`, `-shm`); attachments under `MediaDomain` `Library/SMS/Attachments/` |
| Contacts | `HomeDomain` | `Library/AddressBook/AddressBook.sqlitedb`, `AddressBookImages.sqlitedb` |
| Calls | `HomeDomain` | `Library/CallHistoryDB/CallHistory.storedata` (+ `-wal`, `-shm`) |
| Voicemail | `HomeDomain` | `Library/Voicemail/voicemail.db` and its audio files |
| Notes | `AppDomainGroup-group.com.apple.notes` | `NoteStore.sqlite`; legacy: `HomeDomain` `Library/Notes/notes.sqlite` |
| Photos | `CameraRollDomain` | `Media/PhotoData/Photos.sqlite`, `Media/DCIM/…` |
| Safari | `HomeDomain` | `Library/Safari/History.db`, plus per-profile copies |
| Firefox | `AppDomainGroup-group.org.mozilla.ios.Firefox` / `.Fennec` | `profile.profile/browser.db`, `places.db` |
| Chrome / Edge / Brave | `AppDomain-<bundle id>` | Chromium `History` database |
| Calendar | `HomeDomain` | `Library/Calendar/Calendar.sqlitedb` |
| Voice Memos | `AppDomainGroup-group.com.apple.VoiceMemos.shared` (current); `MediaDomain` `Media/Recordings/` (older) | `CloudRecordings.db` (iOS 12+), `Recordings.db` (11 and earlier); `.m4a` / `.qta` audio |
| Health | `HealthDomain` | `Health/healthdb.sqlite`, `Health/healthdb_secure.sqlite` (encrypted backups only) |

## Appendix C: Schema and format references

- **Backup format history:**
  - [dunhamsteve/ios](https://github.com/dunhamsteve/ios) covers `Manifest.mbdb` → `Manifest.db` (iOS 10.0), the `file` column changes in 10.1, and the encrypted `Manifest.db` with double PBKDF2 in 10.2.
  - [Apple Platform Security](https://support.apple.com/guide/security/sec6483d5760) documents the 10M iterations.
  - hashcat treats the two eras as separate modes (14700 and 14800).
- **Messages:** imessage-exporter (GPL; read it, don't copy it) for column-presence detection and the service values `iMessage`, `SMS`, `rcs`/`RCS` and `iMessageLite`. iOS 16 edit/unsend: [doubleblak](https://doubleblak.com/iOS16iMessage).
- **Notes:** apple_cloud_notes_parser `AppleNoteStore.guess_ios_version`. It uses one column per version as a marker:

  | iOS | Marker |
  |---|---|
  | 11 | `Z_11NOTES` |
  | 12 | `ZSERVERRECORDDATA` |
  | 13 | `ZACCOUNT4` |
  | 14 | `ZLASTOPENEDDATE` |
  | 15 | `ZACCOUNT5` |
  | 16 | `ZACCOUNT6`–`8` |
  | 17 | `ZGENERATION` |
  | 18 | `ZUNAPPLIEDENCRYPTEDRECORDDATA` |
  | 26 | `ZATTRIBUTEDSNIPPET` |

  It also includes `proto/notestore.proto`.
- **Photos:** the osxphotos `_constants.py` model-version table (the `ZGENERICASSET` → `ZASSET` change happens at model 14000), and iLEAPP's `Ph0xx` version branches.
- **Calls:** APOLLO `call_history` (iOS 8–14); iLEAPP notes on the four new `ZCALLRECORD` columns in iOS 26.5, and on `CallHistoryTemp.storedata`.
- **What encrypted backups contain:** Apple [108353](https://support.apple.com/en-us/108353) and [108771](https://support.apple.com/en-us/108771).
- **iCloud-synced data in local backups:**
  - [Elcomsoft](https://blog.elcomsoft.com/2022/02/dude-where-are-my-messages/) says messages are always present.
  - iMazing says message text is present but attachments that were moved to iCloud are missing.
  - These conflict with each other, so settle the question per §7.3.

## Appendix D: Coverage matrix

Target state. ● real backup · ◐ real databases in a rebuilt container (L2) · ○ synthetic only (L4) · blank = not planned.

| iOS | L1 public backup | L2 rebuilt from file system | L3 reference device | L4 synthetic |
|---|---|---|---|---|
| ≤ 9 (`Manifest.mbdb`) | toy only (detection test) | | | ○ (detection and error message) |
| 10 | | | if a used device turns up | ○ |
| 11 | | | if a used device turns up | ○ |
| 12 | | ◐ 12.4 | if a used device turns up | ○ |
| 13 | ● 13.3.1, 13.4.1 | ◐ | | ○ |
| 14 | ● 14.3, 14.4, 14.x (unencrypted) | ◐ 14.2–14.4 | | ○ |
| 15 | ● 15.3.1 | ◐ 15.0.2, 15.3.1 | used device (frozen on 15) | ○ |
| 16 | ● 16.0, 16.1.2 | ◐ 16.1–16.5.1 | ● frozen on 16 | ○ |
| 17 | ● 17.3 | ◐ 17.3–17.6.1 | | ○ |
| 18 | | ◐ 18.0, 18.3.2, 18.7 | ● frozen on 18 | ○ |
| 26 | | | ● current / long-running | ○ |
| 27 | | | ● current / long-running | ○ |
