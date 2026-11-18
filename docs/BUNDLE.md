# OpenExtract Bundle

A data bundle is a folder OpenExtract saves from an iPhone backup: messages, calls,
voicemail, contacts, photo details and people, in plain JSON that any tool can read,
with a SHA-256 hash of every file. In the app it's **Save to computer → For other tools →
Export a data bundle**.

> **Experimental.** This is format version `0.1`. Until it reaches `1.0` the format can
> still change from one version of OpenExtract to the next. Every bundle says which
> version it is (`schema_version` in `manifest.json`), and each version has its own JSON
> Schemas in [`docs/bundle/schema/<version>/`](bundle/schema/). A tool should check
> `schema_version` before it reads anything else.

The engine writes the bundle (`export_bundle` in [`python/bundle.py`](../python/bundle.py)).
Nothing in it goes over the network, and nothing is sent anywhere.

## What's in a bundle

```
OpenExtract Bundle - Maren's iPhone - 2026-11-17/
  manifest.json        what's in the bundle, the backup it came from, the app that made it
  conversations.json   Messages conversations
  messages.jsonl       one message per line, each conversation oldest first
  attachments/         message attachments, copied as they are in the backup
  calls.jsonl          call history, one call per line
  voicemail.jsonl      every voicemail: the Voicemail, Spam and Deleted lists
  voicemail/           voicemail audio (AMR)
  contacts.json        the address book
  photos.jsonl         photo and video details, one per line
  albums.json          the albums photos.jsonl refers to
  photos/              photo and video files (only when asked for)
  people.json          who the backup shows you in touch with
  SHA256SUMS           a SHA-256 hash of every other file
```

The person saving chooses which kinds of data to include, and which files to copy in:
message attachments and voicemail audio are copied by default, photo and video files
only when ticked (they can take tens of gigabytes). A kind left out is in the manifest
with `"included": false` and has no files.

`.json` files are one JSON document, UTF-8, indented. `.jsonl` files are
[JSON Lines](https://jsonlines.org/): one JSON object per line, UTF-8, `\n` line endings,
so a tool can read a file of millions of messages a line at a time.

Text the backup holds that isn't valid Unicode (half an emoji, cut off by a sender's
phone) is written as U+FFFD. Copied files are byte-for-byte what the backup holds,
under a new name: `attachments/<id>-<name>`, `voicemail/<id>.amr`, `photos/<uuid>-<name>`.
Names are changed only where Windows, macOS or Linux wouldn't accept them.

## Dates and time zones

Every date in a bundle is UTC, written like `2024-07-05T16:10:00Z` (with fractions of a
second when the backup has them). Field names end in `_utc` to say so. A date the
backup doesn't have is `null`.

`manifest.json` says `"time_zone_used": "UTC"`, and `computer_time_zone` names the time
zone of the computer that made the bundle (an IANA name like `America/Los_Angeles`), for
a tool that wants to show local times as the app does. It's the computer's zone, not
necessarily the iPhone's.

## The integrity check

`SHA256SUMS` lists every file in the bundle except itself, one per line, in the format
`sha256sum` writes and reads:

```
76c093455cf17a4f470fb9a676698756546fc81a44233ccfa354491a4cfaf448  albums.json
1af53ac441ebc5df9c971c0d9cfcaadd40050f499c6cc1ae6fa355a44a3affd3  attachments/1-IMG_2210.jpeg
```

To check a bundle, from inside its folder:

```bash
shasum -a 256 -c SHA256SUMS        # macOS
sha256sum -c SHA256SUMS            # Linux
```

On Windows, `Get-FileHash -Algorithm SHA256 <file>` gives one file's hash to compare.

This is an **integrity check**: it shows whether a file has changed since the bundle
was made. It says nothing about how the backup itself was made, and it doesn't prove
who made the bundle. `voicemail.jsonl` and `messages.jsonl` also carry the hash of each
audio file and attachment, so a single file can be checked against its record.

## manifest.json

```json
{
  "format": "openextract-bundle",
  "schema_version": "0.1",
  "experimental": true,
  "spec": "https://github.com/charleswest775/openextract/blob/main/docs/BUNDLE.md",
  "created_utc": "2026-11-17T20:36:08.024376Z",
  "app": { "name": "OpenExtract", "version": "0.18.0", "ios_backup_core_commit": "e45e4656…" },
  "time_zone_used": "UTC",
  "computer_time_zone": "America/Los_Angeles",
  "backup": {
    "device_name": "Maren's iPhone", "product_type": "iPhone17,1", "ios_version": "26.5",
    "backup_date_utc": "2026-06-29T04:10:00Z", "encrypted": false, "udid_sha256": "5e4e0f48…"
  },
  "files_copied": { "attachments": true, "voicemail_audio": true, "photos": false },
  "types": {
    "messages": { "included": true, "count": 1410, "first_utc": "2024-07-01T15:12:32Z",
                  "last_utc": "2026-06-28T19:16:59Z", "empty_reason": null,
                  "files": ["conversations.json", "messages.jsonl"], "conversations": 17,
                  "attachments": { "copied": 40, "not_in_backup": 0, "failed": 0 } },
    "calls": { "included": true, "count": 9, … },
    "voicemail": { …, "lists": { "voicemail": 9, "spam": 0, "deleted": 0 },
                   "audio": { "copied": 9, "not_in_backup": 0, "failed": 0 } },
    "contacts": { … }, "photos": { …, "albums": 13, "not_in_backup": 0 }, "people": { …, "sources": [ … ] }
  },
  "integrity": { "algorithm": "SHA-256", "file": "SHA256SUMS", … }
}
```

- `app.ios_backup_core_commit` is the commit of [ios-backup-core](https://github.com/charleswest775/ios-backup-core),
  the library that read the backup, or `null` when the app can't tell.
- `backup.udid_sha256` is a SHA-256 hash of the iPhone's identifier, so two bundles from
  one iPhone can be matched without the bundle naming the iPhone.
- Each entry in `types` says how many records there are and the earliest and latest
  date among them, which is where that kind of data starts and stops in this backup.
  When `count` is 0, `empty_reason` says why:
  - `not_in_backup`: the backup doesn't have this kind of data (many iPhones never have voicemail);
  - `no_records`: it has the database, with nothing in it;
  - `requires_encryption`: iOS only backs it up in an encrypted backup (call history);
  - `unsupported_format`: a layout OpenExtract can't read yet.
- If a kind of data couldn't be read, its entry has an `error` and its files may be
  missing or incomplete. The rest of the bundle is still complete, and still in
  `SHA256SUMS`.
- `photos.not_in_backup` counts photos and videos the Photos library lists whose file
  isn't in the backup (with iCloud Photos, many originals are only in iCloud).
  `photos.jsonl` holds only the ones whose file is in the backup.

## The records

[`docs/bundle/schema/0.1/`](bundle/schema/0.1/) has a JSON Schema (2020-12) for each
file; these are the fields, briefly.

**conversations.json** `{"schema_version", "conversations": [...]}`, each with `chat_id`,
`chat_identifier` (the other person's number or address, or the group's id),
`display_name`, `service`, `is_group`, `message_count`, `first_utc`, `last_utc`, and
`handles` (every number and address seen sending in it).

**messages.jsonl**, one message per line:

| Field | |
|---|---|
| `id` | the message's ROWID in sms.db |
| `chat_id` | its conversation in conversations.json |
| `date_utc` | when it was sent or received |
| `is_from_me` | |
| `sender_handle` | the sender's number or address; `null` when from me |
| `sender_name` | their name in the address book, else their number; `null` when from me |
| `service` | `iMessage`, `SMS` or `RCS`, as sms.db records it for this message (a conversation can mix them); the conversation's when sms.db doesn't say |
| `type` | `text`, `attachment`, `link`, `audio`, `facetime`, `unsent`, `system`, `group_member_added` and the other group changes, `location_*` |
| `text` | |
| `event_text` | what happened, in words, for a group change, an unsent message or a FaceTime call |
| `is_reaction` | a tapback |
| `attachments` | `[{id, filename, mime, size, backup_path, path, sha256, in_backup}]`: `path` is the copy in the bundle and `sha256` its hash (both `null` when not copied); `in_backup` is false when the backup has no file for it |

**calls.jsonl**: `id`, `date_utc`, `address`, `contact_name`, `direction` (`incoming` or
`outgoing`), `status` (`answered`, `missed`, …), `duration` (seconds), `app`, and `source`:
`call_history` for the iPhone's call log, `voicemail` for a voicemail with no call record
(listed as a missed call, as the app's call list does), `messages` for a FaceTime row in
sms.db. Without an encrypted backup, iOS leaves call history out
(`empty_reason: "requires_encryption"`).

**voicemail.jsonl**: `id`, `date_utc`, `phone_number` (always the number, even for a saved
contact), `contact_name` (their name in the address book, or `null`), `duration`, `is_read`,
`folder` (`voicemail`, `spam` or `deleted`: the list the iPhone shows it in), `is_spam`,
`is_deleted`, `transcript`, `audio_path`, `audio_sha256`. `is_spam` and `is_deleted` are
separate: a spam voicemail that was then deleted is in `deleted` with `is_spam: true`.
Transcripts are empty for now: iOS keeps them outside voicemail.db.

**contacts.json** `{"schema_version", "contacts": [...]}`: `id`, `first_name`, `last_name`,
`display_name`, `organization`, `phones`, `emails`, `note`.

**photos.jsonl**: `id` (the asset's UUID), `filename`, `kind`, `date_created_utc`,
`date_modified_utc`, `width`, `height`, `duration`, `favorite`, `hidden`, `latitude`,
`longitude`, `album_ids` (ids in albums.json), `path` and `sha256` (the copied file, when
photo files were asked for). Hidden photos are included.

**albums.json** `{"schema_version", "albums": [...]}`: `id`, `title`, `kind` (`smart`,
`user`, `folder`, `shared`), `parent_id` (the folder it's in), `count`.

**people.json** `{"schema_version", "sources", "people": [...]}`: who the backup shows you
in touch with, merged by the same rules as the app's People screen: texts, calls and
voicemail under one address-book name are one person, and one number written several ways
is one person. Each has `key`, `name`, `identifier`, `identifiers` (every number, as its
last 10 digits, and address, in lower case), `numbers` (as the backup writes them),
`counts` (`messages`, `calls`, `voicemail`), `total`, `last_utc`, `is_group`, `chat_id`, and
`contact_id` (their card in contacts.json, when contacts are in the bundle). `sources` lists
the kinds of data people were worked out from. The rules are in
[`python/people_merge.py`](../python/people_merge.py), a port of
[`src/components/people/gather.ts`](../src/components/people/gather.ts); one fixture
(`python/tests/fixtures/people-merge.json`) is run against both.

WhatsApp, notes, web history and podcasts aren't in bundles yet.

## Versions

| Version | OpenExtract | |
|---|---|---|
| `0.1` | 0.18.0 | First version. Experimental. |

While the major version is `0`, any release can change the format: add, rename or remove
fields or files. Each change gets a new `schema_version` and its own schema folder, and is
listed here. A tool should read only the versions it knows, and treat fields it doesn't
know as something to ignore.

From `1.0` on, the format is a promise: a minor version (`1.1`) only adds fields or files,
so a tool written for `1.0` still reads it; anything that would break a tool is a new
major version (`2.0`).

## Checking a bundle in code

The tests check every bundle they make against the schemas and `SHA256SUMS` with
[`python/tests/bundle_schema.py`](../python/tests/bundle_schema.py), which needs no extra
packages:

```python
from bundle_schema import check_bundle
problems = check_bundle("path/to/OpenExtract Bundle - …")   # [] when it's sound
```

Any JSON Schema 2020-12 validator works with the schema files too.
