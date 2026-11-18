# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- WhatsApp: when the iPhone has WhatsApp but its chats aren't in the backup, the WhatsApp section now says why instead of not showing up at all. WhatsApp's own end-to-end encrypted backup is the usual reason: with it turned on, WhatsApp keeps its chats only in its iCloud backup. The screen says where to turn it off so the next backup includes them (OE-99)
- Save to computer: Export a data bundle saves messages, calls, voicemail, contacts, photo details and people in one folder, in a documented format other tools can read (JSON and JSON Lines, with every date in UTC). It copies message attachments and voicemail audio too, and photo files if you tick them, and lists a SHA-256 hash of every file in SHA256SUMS, so anyone can check that nothing in it has changed since. The format is experimental and may still change: docs/BUNDLE.md describes it

### Changed
- Recover deleted messages: says that it looks for deleted iMessages and texts, and, when the backup has WhatsApp, why deleted WhatsApp messages can't be brought back. If you send a report asking about encrypted or deleted WhatsApp messages, the app now answers it right away (OE-99)

### Fixed
- A backup whose folder is missing some of its files now says so. When a backup folder is copied or moved and the copy stops partway, the backup still lists every file, so Photos showed a grey square for each missing photo and clicking a missing video did nothing. Now a strip above the backup says how many files are missing and what to do, Photos and Backup details leave out the missing ones and say how many there are, instead of calling them only in iCloud, and a video that can't be opened says why (OE-102)
- Voicemail: transcripts now show. The app used to find no transcript for any voicemail, because the iPhone keeps each one in a file of its own next to the recording, not where the app looked. Now the text the Phone app shows is under each voicemail and in the Timeline, search finds words in it, and Save all's voicemails.csv and the data bundle include it
- Voicemail: the list Save all saves (voicemails.csv) now has the caller's number in a Phone Number column. For a caller saved in your contacts it used to show only their name. A new Spam column marks every spam voicemail, including spam you then deleted, which is in the Deleted list
- Voicemail: Save all's dates follow your computer's time zone, as message saves do: the list's Date column shows local time with its offset, and each audio file is named with the local day, so a voicemail left in the evening no longer gets the next day's date. They used to be UTC
- Saved call history, web history and notes show dates in your computer's time zone, as saved messages, WhatsApp chats and podcasts already do. They used to be in UTC, so in California a call made at 5:48 in the evening read 00:48 the next day. In the call history and web history spreadsheets (CSV), the Date column keeps its exact form with your time zone added: 2024-07-05T17:48:12-07:00. A saved note's Created and Modified lines read "Jul 5, 2024, 5:48 PM", and a note without a date says "Unknown date" instead of "None" or nothing

## [0.17.0] - 2026-11-17

Voicemail now has Spam and Deleted lists beside Voicemail, as on the iPhone. Spam voicemails used to be mixed in with the rest, deleted ones still in the backup weren't shown at all, and some older deleted ones showed up as if they hadn't been deleted. Save all saves every list, and a voicemail whose recording isn't in the backup now says so instead of failing to play.

### Added
- Voicemail: Spam and Deleted lists beside Voicemail, as on the iPhone. Spam voicemails used to be mixed in with the rest, and deleted ones that are still in the backup weren't shown at all. Save all saves every list, with spam and deleted voicemails in folders of their own (OE-79)

### Fixed
- Voicemail: older voicemails that were deleted on the iPhone no longer show up as if they were still there, and voicemails newer iPhones keep in a separate store for each phone line are read too, each listed once (OE-79, OE-85)
- Voicemail: a voicemail whose recording isn't in the backup says so, instead of failing to play without a word (OE-85)

## [0.16.0] - 2026-11-16

OpenExtract stays free for everyone, no strings. After an export, a Pay it forward note from Charles asks you to pay what it's worth to you, but only if you can. It has a Pay $5 button, and if you can't, Say thanks lets you send a thank-you note instead. Photos now lists Favorites, Hidden and the album folders you made on the phone. As on the iPhone, All Photos and Favorites leave out photos you've hidden: they're under Hidden. Save to this computer still saves every photo and video, hidden ones included. Back up my iPhone no longer asks for a new password when the iPhone already has a backup password.

### Added
- Pay it forward: OpenExtract stays free, and now asks plainly for $5 from people it helped. After an export, a note from Charles says the app is free, no strings, and asks you to pay what it's worth to you, but only if you can. It has two buttons: "Pay $5" opens the payment page in your browser, and "Say thanks" opens a short thank-you note to send instead if you can't pay. Closing the note (its ×) stops the asks until you next open the app, and "I've paid" stops them for good. A "Pay it forward" button sits at the top of every screen and glows briefly after an export (it stays still if your system is set to reduce motion). It replaces the one-time "Say thanks" card; Say thanks is also still in Settings. Nothing is sent: what you picked stays on your computer, and the app can't see payments
- Photos: Favorites and Hidden are listed under All Photos, and albums sit inside the folders you made on the iPhone, in the same order as on the phone. Folders open and close in the sidebar. With an album, Favorites or Hidden on screen, the save button saves just those photos (Save album, Save favorites, Save hidden). As on the iPhone, All Photos and Favorites leave out photos you've hidden: they're under Hidden, and the home screen, the Timeline and the Year view don't count them. Save to this computer still saves every photo and video, hidden ones included, and says how many of them are hidden (#215)

### Fixed
- Photos: the count next to All Photos no longer changes to the count of whichever album is open, and three albums Photos keeps for itself ("progress-sync" and two more) no longer appear as empty albums
- Back up my iPhone: when the iPhone already has a backup password, set earlier in Finder, iTunes or OpenExtract, the app says so and doesn't ask for a new one. An iPhone keeps that first password and encrypts every backup with it until it's removed, but the app used to ask for a new password and then not use it, so opening the backup afterwards said the password you'd just typed was wrong. Encrypt now stays ticked for such an iPhone, the note says how to remove a password you've forgotten, and the unlock dialog after the backup asks for the earlier password (OE-68)
- Voicemail: when the list couldn't open voicemails the home screen had just counted, it showed SQLite's "unable to open database file". Now a file that went away while the backup was open (removed by a temp-folder clean-up, or on a drive that went to sleep) is found again, Voicemail tries the backup's own copy before giving up, and if it still can't open them it says to check that the drive with the backup is still connected (OE-77)

## [0.15.1] - 2026-11-13

### Fixed
- Back up my iPhone works again. In 0.15.0 every backup stopped at once with "pymobiledevice3 is not installed. Run: pip install pymobiledevice3", on Windows, macOS and Linux: part of the code that talks to iPhones was left out when the app was built. Installing pymobiledevice3 yourself didn't help, because OpenExtract uses its own copy. If that code ever fails to load again, the app says so and no longer suggests pip, and the build now checks for it before anything ships (OE-50, OE-51, OE-54)

## [0.15.0] - 2026-11-12

### Added
- Podcasts: a Podcasts section with the shows you follow in Apple Podcasts and your listening history: the episodes you played, newest first, with how many times you played each one and where you stopped. Shows you don't follow are listed apart. Save your subscriptions as an OPML file, which most podcast apps can import, or every show and episode as CSV. An iPhone backup never includes podcast audio, so each episode has a Get audio button that opens it in your browser, from where the podcast publishes it; OpenExtract itself still connects to nothing. Reading podcasts was contributed by gbaudic (ios-backup-core#25)

### Changed
- Windows: the app's updater now downloads a copy of the installer named `OpenExtract-Update-X.Y.Z.exe` instead of `OpenExtract-Setup-X.Y.Z.exe`. It's the same signed file. The only difference is that GitHub's download counts for each release now show updates and new installs apart; the app still sends nothing. The first update to this version may download the whole installer rather than only the parts that changed

### Fixed
- When a backup in your Recent list has been moved, renamed or deleted, or is on a drive that isn't plugged in, the app says it can't find it and where it looked, and a Find it button lets you choose where it is now. It used to say only "Backup not found" with the iPhone's ID (OE-40)
- Back up my iPhone and every save now refuse a folder inside OpenExtract's own program folder. Updating OpenExtract replaces that folder, which would delete anything saved there, so the app explains and asks you to choose another

## [0.14.0] - 2026-11-11

### Added
- WhatsApp: a WhatsApp section with your chats, groups and broadcast lists, in the order they arrived on the iPhone. Replies show the message they answer, reactions sit under the message they react to, and calls, locations, photos, videos, voice messages and documents show in the chat. Photos and files that WhatsApp didn't keep on the iPhone say so instead of failing. Save a chat, or all of them, as a web page, PDF, CSV or text file. WhatsApp messages also show in the Timeline, in search and under each person in People. The Year view doesn't count them yet, and calls made before WhatsApp 2.24 aren't shown, because older versions keep them somewhere else. If WhatsApp's end-to-end encrypted backup is turned on in WhatsApp's settings, WhatsApp leaves its chats out of the iPhone's backup, so there's nothing to show

### Fixed
- The Timeline no longer shows a red "Calls: Call history not found" error with a Report this problem button on every unencrypted backup. Apple only puts call history in encrypted backups, so that's normal, and the home page already says so calmly. A call history the app couldn't read is still shown as an error

## [0.13.0] - 2026-11-10

### Added
- A Chip in button in Settings, and on the screen after you send a thank-you, opens openextract.app/support in your browser. There you can pay what you like, from $3, once, through Stripe, toward code signing and development. OpenExtract stays free for everyone, nothing unlocks, and the app sends nothing when you click it

### Fixed
- Backing up an iPhone: when the computer's drive fills up partway, the app says there isn't enough free space instead of "[Errno 28] No space left on device"
- Backing up an iPhone: when Apple Devices, iTunes or Finder is syncing the iPhone, the app says so and asks you to wait or close it, instead of "Failed to lock itunes sync file" or "Could not lock the device's sync lock file"
- Backing up an iPhone: when the iPhone asks for its passcode and nobody enters it in time, the app asks for the passcode instead of telling you to tap Trust and check the cable
- Backing up an iPhone into a folder reached through a link, a mapped drive or a short (8.3) Windows name: when another program, such as OneDrive or antivirus software, is using the backup folder, the app says so instead of showing "Access is denied" or "Permission denied" with a file path
- Backing up an iPhone on a Mac or Linux: when a permission problem stops the backup from tidying up its temporary Snapshot folder at the end, the app says it wasn't allowed to change the backup folder instead of "[Errno 13] Permission denied: '61'"
- Turning on encryption for a backup into a folder where an earlier try didn't finish no longer fails with "The folder you chose has an unfinished backup of this iPhone" (OE-6)
- Backups keep the computer awake while they run. A computer that went to sleep disconnected the iPhone partway through a big backup, often after a few GB, even with the iPhone still plugged in. On Windows the screen now stays on during a backup, because that is what keeps a laptop from sleeping. Closing a laptop's lid still puts it to sleep, and the app then says that's what stopped the backup
- When the connection drops partway through a backup, the message says how much had been copied and points to sleep or the USB connection. It used to ask you to tap Trust, or on an encrypted backup to enter your passcode, which can't be the problem once data is flowing
- Back up my iPhone: when the iPhone hangs up before it has finished tidying the backup away, the app says the connection dropped partway, instead of saying the backup finished and opening it as if it were complete
- Back up my iPhone: a big backup that takes more than 2 hours no longer stops partway with "Sidecar call timed out: backup.start" while it's still copying. The app now gives up only after 2 hours with no progress at all. Saving to this computer works the same way: a big save that's still making progress no longer stops after 6 hours
- Backups made by iOS 6 no longer stop OpenExtract a few moments after they open. Reading their photos used to end the part of OpenExtract that reads backups, so Messages, Contacts, Notes, Photos and everything after failed with "Sidecar exited with code 1", then "Python sidecar is not running", until you quit. Their photos show now, and anything else the engine can't send is reported as an error on that screen instead of stopping it
- If OpenExtract can't look for the backups on this computer, the first screen says so and has a Look again button. The "Also on this computer" list used to just disappear
- A backup that stopped partway, made by OpenExtract or another app, is marked "Didn't finish" in the list of backups found on this computer (and in Recent once you've opened it), and opening it says so above every screen, instead of opening as if it were complete and then failing one section at a time (Calls showed "file is not a database"). What arrived can still be looked at. One that stopped before there was anything to open says so, instead of "No iPhone backups found". OpenExtract's own backups now record when they finish, so this doesn't rely on guesswork (OE-31)

## [0.12.0] - 2026-11-07

### Added
- The first screen lists the backups Finder, iTunes and the Apple Devices app saved on this computer, each with an Open button, so most people don't need to pick a folder. Backups already in your list aren't shown twice. On a Mac, macOS hides that folder until OpenExtract has Full Disk Access, so the first screen offers to explain how to allow it

### Changed
- "Not now" on the "Keep OpenExtract up to date?" card no longer turns update checks off for good. The card comes back a week later, and only switching it off in Settings saves a no

### Fixed
- Windows: the installer no longer crashes as it starts on a PC where OpenExtract isn't installed (including after uninstalling it). On GitHub's Windows test machines about one such install in three stopped before showing anything, silent or not; running it again usually worked. Installing over an earlier version, and updates from inside the app, weren't affected
- Encrypted backups of iPhones on iOS 10.0 or 10.1 open now with their password. They used to fail with "Failed to decrypt backup: b'DPSL'" even when the password was right

## [0.11.0] - 2026-11-07

### Added
- You can say thanks from inside the app. After your first export, the "Your file is saved" card has a Say thanks button, and so does Settings. If you saw the older version of that card, the new one shows once on your next export. If you answer "Looks right" when the app asks whether an export came out right, it offers once more. A thank-you sends only what you write (even nothing at all), privately, with no details about your computer or backup. You can tick a box to let your words be quoted on openextract.app without your name. Once you've sent one, the app stops asking
- "Report this problem" has a "Common fixes" link beside it. It opens openextract.app/fixes, which lists what to do for each error OpenExtract knows about, by the words the app shows
- Messages saved as a web page include their photos, GIFs, videos and other attachments. They're copied into a folder beside the page (Mom.html gets Mom_attachments), so you can move or share the two together. Photos and GIFs show in the conversation, videos and most audio play in it, and every attachment links to its file, so a voice message or a video your browser can't play still opens in another app
- Backups made by iOS 9 and earlier open now: iTunes backups from about 2011 to 2016, the ones with a Manifest.mbdb file instead of Manifest.db. They used to not show up at all. Encrypted ones open too, with their password. Messages, Contacts, Calls, Photos and Notes all read, including the older call history and notes those iPhones kept. Messages from iOS 5 and earlier still can't be read, and the Messages screen says so
- Saving photos shows how far it has got: "Saving 1,234 of 5,678 photos and videos…" with a bar that fills as it goes, on the Photos screen and on Save to this computer. A big library can take a long while, especially from an encrypted backup, and the button's "Saving…" alone looked stuck. Photos that couldn't be copied are counted as it goes

### Changed
- Saved conversations get file names you can read: "Karin Lindqvist, Jul 5 2024 - Jun 21 2026.html" instead of "Karin_Lindqvist--240705091009-000000--260621170638-000000.html". One day reads "Karin Lindqvist, Jul 5 2024", and names keep their accents and emoji. Saving the same conversation again adds " (2)" to the new file instead of replacing the first one, as PDFs already did
- Messages: notices in a conversation say what happened instead of "[Conversation event]": who added or removed someone, who left, who renamed the conversation and to what, who changed or removed the group photo, who unsent a message, and FaceTime calls. For example "Karin added Theo to the conversation" or "You unsent a message", with names from your contacts. They read the same in the app, the Timeline and saved TXT, CSV, HTML and PDF files. Notices OpenExtract can't name yet say "[Conversation update]"

### Fixed
- Saving photos, or anything else, to this computer no longer fails with "Sidecar call timed out" when it takes longer than five minutes, as a big photo library can. Thumbnails you scroll to while it saves now show up when it's done instead of failing
- Saved messages show each time in your computer's time zone, written the way people read it: "Jul 5, 2024, 9:10 AM". They used to show it in UTC, as 2024-07-05T16:10:09+00:00, so in California a message sent at 9:10 in the morning read 16:10, and an evening message could land on the next day. Web pages and PDFs show each day's date once, above its first message, like the conversation in the app. In a spreadsheet (CSV), the Date column keeps its exact form with your time zone added: 2024-07-05T09:10:09-07:00
- Photos and videos you save now have the date they were taken as their file date, so Finder, File Explorer and photo apps sort them in the order you took them. They used to have the date of the backup instead, so a whole library could look like it was taken on the same day

## [0.10.2] - 2026-11-06

### Changed
- macOS and Linux: OpenExtract can open a backup as soon as its window appears. Its engine used to unpack itself into a temporary folder every time it started, which could keep you waiting several seconds more on a Mac. It now comes as a folder, as it already did on Windows, and starts in a fraction of a second

### Fixed
- Windows: backups in a folder whose name has accents or other letters outside English (C:\Users\José, for example) open now; they used to fail. Save to this computer → Messages no longer stops partway through when a conversation's name has an emoji, and no longer writes files with garbled names
- Mac: after closing OpenExtract's window, reopening it from the Dock left it unable to open or read anything until you quit the app. It works straight away now
- If the engine can't be started at all, the app says so right away instead of waiting five minutes
- Back up my iPhone: an encrypted backup of an iPhone that had never made one failed with "No such value." It works now
- Back up my iPhone: when the iPhone itself is too full to make a backup, the app says so. It used to say the drive you chose didn't have enough free space, even on a nearly empty external drive
- Back up my iPhone: three more failures say what to do instead of showing a technical error: the iPhone couldn't send some of its files (error 104), the folder holds an unfinished backup from an earlier try (error 205), and Windows wouldn't let OpenExtract change a file in the backup folder ("Access is denied")

## [0.10.1] - 2026-11-04

### Fixed
- Windows: Back up my iPhone on a PC without Apple's iPhone software used to show a red error. It now explains that Windows needs Apple Devices, Apple's free app, and installs it for you from the Microsoft Store with one click, without needing an administrator (or opens the Store page if you'd rather do it yourself). If Apple Devices is installed but not running yet, as it isn't right after installing, OpenExtract starts it. Opening backups you already have never needed it
- Other errors while looking for an iPhone now have a Report this problem link
- Back up my iPhone asks your iPhone to trust this computer once. Every search used to start a new request, so you could be asked to tap Trust and enter your passcode several times in a row. The app now says when to tap Trust, and when the iPhone wants its passcode to start the backup
- A backup could fail right after you entered your passcode, with a technical "Device locked (MBErrorDomain/208)" error. OpenExtract retried this automatically with older versions of the library it uses to talk to iPhones, but not with newer ones, which word the error differently. It retries again now, and if your iPhone is still locked it asks you to unlock it and click Retry
- Unplugging your iPhone during a backup now says it was disconnected. An encrypted backup used to say the iPhone was asking for its passcode, and a backup into a folder you'd backed up to before could even say it had finished
- Back up my iPhone's progress bar no longer jumps to about 90% in the first moments and sits there for most of the backup. It now climbs with the iPhone's own progress all the way through, and a count of how much has been copied ("12.43 GB copied") keeps moving every second, even while the iPhone's percentage pauses on large files. Before that, while the iPhone gets ready and asks for its passcode, the bar stays at 0% instead of showing 11% "Backing up files"
- Back up my iPhone selects your iPhone when it's the only one connected, as it is the first time. You used to have to click it before you could start

## [0.10.0] - 2026-11-03

### Changed
- A new look that's simpler to find your way around. A backup opens on a home page of large tiles, one for each kind of data with its count, and a search box sits at the top of every screen instead of the row of icons down the side. Kinds the backup doesn't have get a tile that says why. Every screen has a Home button and shows where you are, and a Tools row on the home page leads to Recover deleted messages, Save to this computer and Backup details
- Overview is now called Backup details, Contacts is now Address book, and Browser history is now Web history
- Each screen's own search box is gone; the one at the top filters the screen you're on (Messages had three search boxes, now it has one)
- Send feedback no longer needs a GitHub account. Send delivers the report privately to OpenExtract's developer, with an optional email if you'd like a reply, and shows a reference number. If the report looks like a known problem, the fix appears right away. If sending fails, you can copy the report or post it on GitHub instead

### Added
- Search the whole backup from the home page. Results are grouped by kind (notes, messages, voicemail, calls, photos, web history and people), with matches highlighted and a preview. Case and accents don't count, so "cafe" finds "Café"; every word must appear, in any order; text in quotes must appear as written; and phone numbers match however they're punctuated. Notes are searched in full, not just their first lines. ⌘K (Ctrl+K on Windows and Linux) jumps to the search box from anywhere
- Opening a search result shows that exact record: a message inside its conversation, with "3 of 12 ↑ ↓" to step through the matches, a voicemail opened, a photo full size, or a call or web visit marked in its list
- People: everyone you were in touch with by message, call or voicemail, most first. Each person has one page with all of it and Save everything, and links to their Address book card and back
- When a problem you reported is fixed, OpenExtract tells you. While a report is open, the app checks on it every few days, sending only the report's number and a random code (see the privacy page)
- Year view: a heatmap of the backup with one square per day, darker the more happened. Filter by type and person, hover for a day's counts, click a day to open it in the Timeline. Days the backup doesn't reach, such as messages kept only in iCloud, show as not in this backup instead of quiet

### Fixed
- Clicking a photo opens it full size; it used to do nothing
- A backup is read once when it opens, and Search, People and the Timeline share it, instead of each of them reading the whole backup again
- Windows: the app opens backups on PCs with Smart App Control turned on. The engine used to unpack its libraries into a temporary folder each time it started, most of them unsigned, and Smart App Control stopped it before it could answer ("Python sidecar is not running"). It now ships as a folder in which every file is signed (#169)
- If a library the engine needs only for encrypted backups can't be loaded, other backups still open
- A feedback report about an engine that crashes as it starts now includes the error, not just its exit code
- The Timeline's date filter no longer leaves out items in the last second of the end date
- Linux (Flatpak): the app no longer offers to check for or install updates itself; Flathub keeps it up to date, and Settings says so

## [0.9.0] - 2026-11-02

### Added
- Send feedback from inside the app: a Feedback button in the header and the sidebar, "Report this problem" next to error messages, and a "Did this export come out right?" card after an export (at most once per run, with "Don't ask again"). The form fills in the app version, system, phone model, iOS version and recent errors, with folder names, device names, emails and phone numbers replaced by placeholders, and shows all of it so you can edit or delete any of it. OpenExtract still sends nothing: the report opens in your browser as a GitHub issue, and you send it from there (a free GitHub account is needed)

### Fixed
- When the engine crashes, the app says so right away instead of waiting up to five minutes with no message

## [0.8.1] - 2026-11-02

### Added
- After the first successful export, a one-time card asks for a GitHub star or a word to a friend (Star on GitHub, Copy link, Get release notes, Not now). It shows once, is remembered on this computer, and sends nothing anywhere

### Fixed
- Windows and Linux: typing in a text field no longer downloads spell-check dictionaries from Google. Text fields no longer underline misspelled words
- Calls: calls from Teams, Skype and other apps show a readable name instead of unreadable characters
- Calls: numbers saved in a national format, like 06 12 34 56 78, now match calls logged in international format, like +33 6 12 34 56 78
- Calls: backups with the older call history format no longer fail to list their calls
- The app icon is OpenExtract's own coral "o" mark instead of the default Electron icon, and the website's tab icon matches it instead of a placeholder
- Windows: the DLLs that come with Electron (ffmpeg.dll, libEGL.dll, libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll) are signed along with the app, as the Microsoft Store requires

## [0.8.0] - 2026-10-28

### Added
- Export a conversation as PDF, with its photos, from the Messages view (single or several conversations) (#91)
- HTML and PDF message exports end with one small line: "Made with OpenExtract, free at openextract.app"

### Fixed
- Photos counts only the photos that are in the backup. With iCloud Photos and "Optimize iPhone Storage", the Photos header, album counts, and the Overview tile and card used to count every photo in the library; the rest get one line saying how many are only in iCloud, so the backup doesn't have them (#106)
- The Photos grid loads to the end instead of stopping partway, sometimes showing a photo twice (#106)
- Photos that iCloud Photos keeps from your other devices are found, and encrypted backups no longer show tiles for photos that aren't in the backup (#106)
- Message exports and the conversation view say what a message without text is ("You started sharing your location", "Audio message not in this backup", "Conversation event") instead of "[Attachment]" or a code like "[location_started_by_me]"; HTML exports name each attachment ("[Image: IMG_0042.HEIC]")
- Exporting from a conversation's menu shows an error if it fails, instead of doing nothing
- Windows: in an encrypted backup, a file whose name has a character Windows doesn't allow (such as `?` or `:`) couldn't be opened and was reported as not in the backup (ios-backup-core#16)
- Opening a backup again releases the earlier copy's files instead of keeping them locked until later (#146)

### Changed
- Tests and CI run on Linux, macOS and Windows, and a pre-release check builds the app on all three and tries it on test backups (#146)

## [0.7.0] and earlier

Not broken out by version. See [GitHub Releases](https://github.com/charleswest775/openextract/releases) for each version's notes.

### Added
- Initial project scaffold
- Electron + React + Python sidecar architecture
- Backup discovery for macOS and Windows
- Encrypted backup support via iphone_backup_decrypt
- Message extraction from sms.db with contact resolution
- Chat-bubble message viewer UI
- Photo extraction from CameraRollDomain
- Voicemail, call history, contacts, and notes extractors
- Export to TXT, CSV, and HTML formats
- Backup test corpus: tests against real public iPhone backups (iOS 13–17), run weekly in CI (see `corpus/README.md`)

### Fixed
- Stats dashboard counted every conversation as a group chat
- Photos on iOS 13 and earlier backups had no dates, albums or stats
- Photo details on iOS 15+ were missing the modified date and burst ID
