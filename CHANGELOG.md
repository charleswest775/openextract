# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Windows: backups in a folder whose name has accents or other letters outside English (C:\Users\José, for example) open now; they used to fail. Save to this computer → Messages no longer stops partway through when a conversation's name has an emoji, and no longer writes files with garbled names
- Mac: after closing OpenExtract's window, reopening it from the Dock left it unable to open or read anything until you quit the app. It works straight away now
- If the engine can't be started at all, the app says so right away instead of waiting five minutes

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
