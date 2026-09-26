# OpenExtract

A free, open-source desktop application for extracting text messages, photos, voicemails, call history, contacts, and notes from iPhone/iPad backups.

**No cloud. No subscriptions. Your data stays on your computer.**

## Features

- 💬 **Messages** — Browse iMessage/SMS conversations with chat-bubble UI
- 📷 **Photos & Videos** — Gallery view with thumbnails and bulk export
- 📞 **Voicemail** — Listen to voicemails with caller ID
- 📋 **Call History** — View calls with contact name resolution
- 👤 **Contacts** — Browse and export your address book
- 📝 **Notes** — Read and export your iOS notes
- 🔒 **Encrypted Backups** — Full support for password-protected backups
- 📤 **Export** — Save conversations as PDF, HTML, CSV, or plain text

## Quick Start

### Prerequisites

- **Node.js 18+** and npm
- **Python 3.11+**
- An iTunes/Finder backup of your iPhone on this computer

### Setup

OpenExtract's parsing engine lives in a separate library,
[ios-backup-core](https://github.com/charleswest775/ios-backup-core), which
`python/requirements.txt` installs from a **sibling folder**. Clone both repos
side by side, or `pip install` will fail and the app will report
`ModuleNotFoundError: No module named 'ios_backup_core'`:

```
your-dev-folder/
├── openextract/
└── ios-backup-core/
```

```bash
# Clone both repos side by side
git clone https://github.com/charleswest775/ios-backup-core.git
git clone https://github.com/charleswest775/openextract.git
cd openextract

# Install Node dependencies
npm install

# Install Python dependencies
cd python
pip install -r requirements.txt
cd ..

# Start the development server
npm run dev
```

This will launch Vite (React dev server) and Electron together. The app will auto-detect iPhone backups in the default locations:

- **macOS:** `~/Library/Application Support/MobileSync/Backup/`
- **Windows:** `%APPDATA%\Apple Computer\MobileSync\Backup\`

### Creating a Backup

If you don't have a backup yet:

1. Connect your iPhone to your computer via USB
2. Open **Finder** (macOS) or **iTunes/Apple Devices** (Windows)
3. Select your device
4. Check "Encrypt local backup" (recommended — gives access to more data)
5. Click "Back Up Now"

## Architecture

```
Electron (window, menus, file dialogs)
    ↕ IPC
React Frontend (UI components)
    ↕ JSON-RPC over stdin/stdout
Python Sidecar (backup parsing, SQLite queries, decryption)
```

The Python sidecar handles all backup reading and is bundled as a standalone executable for distribution (via PyInstaller). Users never need to install Python.

## Project Structure

```
openextract/
├── electron/          # Electron main process + sidecar manager
├── src/               # React frontend
│   ├── components/    # UI components
│   ├── hooks/         # React hooks for state management
│   └── lib/           # Utilities (IPC client, date formatting)
├── python/            # Python sidecar engine
│   ├── main.py        # JSON-RPC server
│   ├── backup.py      # Backup discovery & management
│   ├── messages.py    # SMS/iMessage extraction
│   ├── contacts.py    # Address book parsing
│   ├── photos.py      # Photo/video extraction
│   ├── voicemail.py   # Voicemail extraction
│   ├── calls.py       # Call history parsing
│   └── notes.py       # Notes extraction
└── scripts/           # Build scripts
```

## Building for Distribution

```bash
# Bundle the Python sidecar
cd python
pyinstaller --onefile --name openextract-engine main.py
cd ..

# Package the Electron app
npm run package
```

Output will be in the `release/` directory.

## Privacy

OpenExtract runs 100% locally. Your backup data never leaves your computer. The source code is fully auditable — that's the point of being open source.

## License

MIT — use it however you want.

## Contributing

PRs welcome! Key areas where help is needed:

- Testing across iOS versions (schema changes between versions)
- Windows testing and packaging
- Photo gallery UI
- PDF export with proper formatting
- Accessibility improvements
