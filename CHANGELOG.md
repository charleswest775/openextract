# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
