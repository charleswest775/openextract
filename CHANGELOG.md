# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Year view: a heatmap of the backup with one square per day, darker the more happened. Filter by type and person, hover for a day's counts, click a day to open it in the Timeline. Days the backup doesn't reach, such as messages kept only in iCloud, show as not in this backup instead of quiet

### Fixed
- The Timeline's date filter no longer leaves out items in the last second of the end date

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
