<!-- WhatsApp extraction: the ios-backup-core extractor (PR #28) and the app section built on it. Written 2026-11-10. -->

# WhatsApp extractor design (ios-backup-core, branch claude/whatsapp-extractor)

Verified against the five public Hickman backups in the corpus (WhatsApp 2.20–2.24) and the creator's activity logs.

## Module
`src/ios_backup_core/extractors/whatsapp.py`, class `WhatsAppExtractor`. Plain dicts. Per-call connections closed in try/finally (Windows). Small per-instance cache of side data (owner, LID map, ContactsV2 and push names, media file list) keyed by accessor and by the ChatStorage path, mtime and size; no cached connections.
`protobuf.py` gains a field-aware decoder `parse_fields(data)` plus helpers; `extract_protobuf_strings` unchanged.

Files (domain `AppDomainGroup-group.net.whatsapp.WhatsApp.shared`):
- `ChatStorage.sqlite` (required), `ContactsV2.sqlite` (≤ WA 2.23), `LID.sqlite` (≥ WA 2.23),
- `Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist` (OwnJabberID, lid, lidd, FullUserName),
- media `Message/` + ZMEDIALOCALPATH / ZXMPPTHUMBPATH / ZTHUMBNAILLOCALPATH (never double-prefix).

## Public API
- `has_whatsapp(backup)` → `{"has_whatsapp": bool, "chats": n, "messages": n}` (listable chats, messages in them).
- `list_conversations(backup, contacts)` → `{"conversations": [...]}`. Keys = MessageExtractor's 8 (`chat_id`=ZWACHATSESSION.Z_PK, `chat_identifier`=ZCONTACTJID, `display_name`, `service`="WhatsApp", `message_count` (counted rows, never ZMESSAGECOUNTER), `last_message_date`, `last_message_preview` (from the last row by ZSORT; never ZLASTMESSAGETEXT), `is_group`) + `chat_jid`, `chat_type` (individual|group|broadcast), `archived`. Lists session types 0, 1 and real broadcast lists (2, not status@broadcast); hides status (3, `@status`, `status@broadcast`). Only chats with ≥1 message. Newest first.
- `get_messages(backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None)` → `{"messages", "total", "next_offset", "offset", "limit"}`. Ordered by ZSORT (arrival order), never Z_PK/ZMESSAGEDATE. offset counts from the newest; page returned oldest-first; date filter inside the page query on ZMESSAGEDATE.
  Message keys = MessageExtractor's 12 (`message_id`=Z_PK, `text`, `message_type`, `event_text`, `link_preview`, `date`, `is_from_me`, `sender` ("me" when from me), `sender_handle` ("+digits" for phone JIDs, else raw JID or ""), `has_attachments`, `attachments`, `is_reaction` (always False)) + `sort`, `sender_jid`, `quoted`, `reactions`, `call`, `location`, `received_date`.
  Attachments: 5 keys (`attachment_id`=ZWAMEDIAITEM.Z_PK, `filename`=backup-relative path, `mime_type`, `transfer_name`, `total_bytes`) + `thumbnail_path`, `width`, `height`, `duration`, `available` (path resolves in the backup).
- `search_messages(backup, query, contacts, chat_id=None, date_from=None, date_to=None, limit=500)` → `{"results": [...], "query": q}`; keys message_id, text, date, is_from_me, sender, chat_id (+ chat_name). Matches ZTEXT and media ZTITLE (captions/document names).
- `get_message_offset(backup, chat_id, message_id)` → `{"offset": n, "found": bool}` = rows in chat with larger ZSORT.
- `get_attachment(backup, attachment_id, thumbnail=False)` → `{"path", "mime_type", "filename"}` or `{"error": ...}`.
- `BackupReader.whatsapp(chat_id=None, **kw)`.

Empty states (voicemail contract): DB not in Manifest → `empty_reason: "not_in_backup"`; listed but unreadable → `error` (no empty_reason); no ZWAMESSAGE/ZWACHATSESSION tables → `error` + `empty_reason: "unsupported_format"`; no listable chat → `empty_reason: "no_records"`. List keys always present.

## Semantics (verified on 5 corpus items unless marked)
- ZGROUPEVENTTYPE is an event code only for ZMESSAGETYPE 6, 10 (55: channel). Elsewhere it marks direction.
- Types: 0 text (a media row = reply context only), 1 image, 2 video*, 3 audio/voice*, 4 contact*, 5 location (ZMEDIAORIGIN=1 live), 7 link*, 8 document*, 11 GIF*, 14 deleted for everyone*, 15 sticker*, 38/39/53 view-once*, 46 poll*, 54 round video*, 59 call (ZMETADATA 87.1: 1 video, 2 outcome enum, 3 duration s), 6/10 system with event text. Unknown types: kept (never dropped), `message_type` "unknown", attachment if a file exists, MIME from ZVCARDSTRING when it looks like a MIME type. (* = external sources only)
- 10/2 E2E notice; 6/12 group created (creator from ZWAGROUPINFO.ZCREATORJID, else neutral); 6/2 member added ("You were added" when ZTOJID is the owner, actor unknown); 10/56 neutral wording (meaning disputed); 10/1,45 missed voice call*, 10/4,46 missed video call*; other codes → neutral "WhatsApp notice" keeping the raw code in `event_code`.
- Images: ZLATITUDE/ZLONGITUDE = height/width; ZVCARDSTRING = MIME. Coordinates only on type 5. Thumbnails (.thumb) are JPEG.
- Replies: ZMETADATA f5 quoted ZSTANZAID (match in same chat), f6 quoted sender JID (absent → owner), f19.1 text, f19.3 image.
- Reactions: ZWAMESSAGEINFO.ZRECEIPTINFO f7: 7.1 repeated {2 jid, 3 emoji, 4 ms}, 7.2 owner {2 emoji, 3 ms}; empty emoji skipped. Attached to the target message, never separate rows.
- ZPUSHNAME (WA ≥ 2.23) and ZLASTMESSAGETEXT are base64 protobuf: never displayed. Plain-text ZPUSHNAME (older) may be a name fallback.
- Dates: Apple-epoch seconds stored as int or real → float. Sentinels (year 1 / 4001) → None. `received_date` = ZSENTDATE on received rows.
- Deleted-for-me messages leave a ZSORT gap and no row (nothing to show).

## Names
canon(jid): strip `:<device>`; `@s.whatsapp.net`/`@c.us` digits → phone; `@lid` digits → LID; groups/broadcast/status/newsletter → never looked up in the address book.
LID → owner (plist lid/lidd, LID pairs whose phone is the owner) or phone via LID.sqlite ZWAPHONENUMBERLIDPAIR (bare digits).
Order: owner → address book `resolve_contact("+"+digits)` → ContactsV2 ZFULLNAME → ZWACHATSESSION.ZPARTNERNAME (1:1, not phone-like) → ZWAGROUPMEMBER ZCONTACTNAME/ZFIRSTNAME → ZWAPROFILEPUSHNAME → "+digits"; unmapped LID → "Unknown member".
Group sender: ZGROUPMEMBER → ZWAGROUPMEMBER.ZMEMBERJID; else person ZFROMJID; else plain-text push name; else "Unknown member". Group name: ZPARTNERNAME, else "WhatsApp group".

## Not in this step
Call list for the Calls tab (type 59 + CallHistory.sqlite + dedupe vs CallKit), read receipts, profile pictures, polls' options, link previews (ZWAMESSAGEDATAITEM rows never seen), status updates.

## Changes after the review (2026-11-10)
- `message_type` for a static location is `shared_location` (MessageExtractor's `location` means a location-sharing notice); `live_location` unchanged. Location dicts carry `attachment_id` so `get_attachment(id, thumbnail=True)` serves the map preview.
- No empty bubbles: locations get `event_text` "Location"/"Location: <place>"/"Live location", contact cards with no name "Contact card", media-less non-text rows their preview label, unknown types "Unsupported message".
- Media not in the backup: `filename` "" (never None) and `transfer_name` a label ("Photo", "Video message", ...).
- 6/2 with no member and no text addressed to the owner → "You were added" (real shape in all corpus groups the owner didn't create); a member reference that doesn't resolve stays "A member was added".
- Quotes: captions of quoted media (ZWAMEDIAITEM.ZTITLE; copies 19.3.3, 19.9.7, document file name 19.7.8). Captions keep line breaks (names are cleaned, free text only stripped).
- `last_message_date` is the preview row's own date (falls back to the chat's latest date when that row has none).
- `has_whatsapp` and `search_messages` carry `error`/`empty_reason` like the other methods.
- Robustness: text_factory replaces invalid UTF-8; non-numeric values in numeric columns, NaN/Infinity, bad parameters (string ids, negative/huge offsets, limit None/0) and accessors that raise all become safe results; zero-length store → unreadable; NULL ZSORT handled in get_message_offset.
- Cache keyed by accessor (WeakKeyDictionary) + (path, mtime, size); `clear_cache()` public. Names WhatsApp keys by LID survive a LID→phone mapping.
- `vcard` key on every message.

## The app (step 2, 2026-11-10)

WhatsApp is its own section in the app, next to Messages.

Engine (`python/whatsapp.py`, over the library class):
- Methods `list_whatsapp_chats`, `get_whatsapp_messages`, `get_whatsapp_message_offset`, `search_whatsapp_messages`, `get_whatsapp_attachment`, `export_whatsapp_chat`, `export_whatsapp_chats`. They are separate from Messages' methods because the ids overlap with sms.db's; a WhatsApp id never goes to a Messages method. Exports start with `export_` so Electron gives them its long time limit.
- `get_whatsapp_attachment` returns base64 by default, or `too_large` above 25 MB. With `as_file` it returns a copy named with its real extension, plus `openable`. Only photos, video, audio and documents on an allow-list are openable; the screen shows anything else in its folder instead of opening it, and the Electron main process refuses to open programs and scripts as a second guard. Copies live in `openextract-whatsapp-<pid>-*` temp folders, which are swept when the engine starts. A file that isn't in the backup is `{error, empty_reason: "not_in_backup"}`, so feedback doesn't count it as a failure.
- Exports (txt, csv, html, pdf_source) keep arrival order. They write notices without a sender, replies, reactions, calls and locations (with the map preview), and copy media from the WhatsApp domain. Every page is checked for an error. CSV cells are guarded against formulas.
- `get_backup_stats` overview: `total_whatsapp_messages`, `total_whatsapp_chats`, `whatsapp_status`. The import is guarded: with a library that lacks the extractor, WhatsApp reads as not in the backup.
- The library returns `handle` ("+digits") on one-to-one chats, so People and the Timeline match a chat to the person's texts and calls.

Screen:
- `MessageExplorer` takes a `ChatSource` (Messages by default, WhatsApp in `WhatsAppExplorer`).
- `ChatBubble` draws WhatsApp's extras only when they're present, plus a centred `variant` for system notices.
- `WhatsAppAttachment` loads thumbnails first, never asks for a file the backup lacks, plays voice notes from a blob and opens other files through `as_file`.
- Two fixes apply to both sections: day groups are keyed stably (`src/lib/dayGroups.ts`), and list and page errors show with a Report button.
- The section shows when the overview counts WhatsApp messages, or when `whatsapp_status` is `error` or `unsupported_format`, so the error can be seen. It is never listed as "Not in this backup", because most iPhones don't have it.

Everywhere else: index entries of type `whatsapp` (ids `whatsapp:<Z_PK>`) feed the Timeline, whole-backup search, People (WhatsApp chats join a person by number, never by name alone) and the Timeline save. The open option is `waChatId`; the feedback area is `whatsapp`.

Tests:
- `python/tests/whatsapp_backup.py` builds a fictional WhatsApp backup: Einstein plus ChatStorage, so ids collide with sms.db, and an encrypted one through backupgen's `BackupWriter`. Its CLI writes a demo backup for screenshots: `python python/tests/whatsapp_backup.py --out DIR`.
- Contract cases and empty states cover every method. Corpus invariants check the RPCs against raw ChatStorage SQL on the five Hickman items. Hashed spot facts come from the 15.3.1 activity log. Its four call facts are strict xfails, because WhatsApp 2.23 keeps calls in its own CallHistory.sqlite.

Order to merge: ios-backup-core#28 (with the `handle` commit) first. CI clones library master, and the WhatsApp tests fail under `OPENEXTRACT_REQUIRE_GENERATED=1` until it has the extractor. The site's feedback API has to ship the `whatsapp` area before an app release sends it, which happens when the PR merges, since the site deploys from main.

### Still to do
- Year view counts. It needs a library `day_counts` and person matching by `+digits`.
- Calls before WhatsApp 2.24, from WhatsApp's own CallHistory.sqlite, with dedupe against the phone's call log.
- A backupgen WhatsApp writer and persona data, so Maren shows WhatsApp in e2e runs and README screenshots.
- People: merge one person across different names for the same number beyond what the address book links.
- After the release, the website pages that say OpenExtract doesn't read WhatsApp (llms.txt, vs-ibackup-viewer, vs-reincubate, imazing-alternatives, the Windows use case, the German page).
- Messages' CSV export has the same formula-cell gap that WhatsApp's now guards against.
