# OpenExtract — Claude Code Project Brief

## What This Is

OpenExtract is a free, open-source desktop application (MIT licensed) that extracts data from iPhone backups. It is a direct alternative to iMazing, targeting users who need backup access without paying for proprietary software.

Built with Electron + React/TypeScript (frontend) and a Python sidecar (backend parsing engine).

---

## Architecture Overview

```
┌─────────────────────────────┐
│  Electron Shell             │
│  ┌───────────────────────┐  │
│  │  React / TypeScript   │  │  ← UI, routing, state
│  │  (Renderer Process)   │  │
│  └───────────┬───────────┘  │
│              │ IPC (ipcMain/ipcRenderer)
│  ┌───────────▼───────────┐  │
│  │  Main Process         │  │  ← Spawns Python sidecar
│  └───────────┬───────────┘  │
└──────────────┼──────────────┘
               │ JSON-RPC over stdin/stdout
┌──────────────▼──────────────┐
│  Python Sidecar             │  ← PyInstaller binary
│  (Backup Parser Engine)     │  ← Reads iPhone backup files
└─────────────────────────────┘
```

### IPC Protocol
- Electron main process **spawns** the Python sidecar as a child process
- Communication is **JSON-RPC over stdin/stdout** — not HTTP, not sockets
- Each request from main → sidecar is a JSON-RPC object with `id`, `method`, `params`
- Each response from sidecar → main is a JSON-RPC object with `id`, `result` or `error`
- The `id` field is critical — duplicate or missing IDs cause 400-class errors; always ensure IDs are unique per session

### Python Sidecar
- Packaged via **PyInstaller** into a self-contained binary
- Responsible for: locating backup directories, parsing SQLite databases, reading manifest files, extracting file content
- Should be stateless per-request where possible
- Entry point receives JSON-RPC on stdin, writes response to stdout, errors to stderr

### Frontend
- **React + TypeScript** in the Electron renderer process
- Communicates with main process via Electron's `ipcRenderer` / `ipcMain` bridge
- Do NOT make direct calls to the Python sidecar from the renderer — always go through main process

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React + TypeScript |
| Backend/parsing | Python (PyInstaller sidecar) |
| IPC | JSON-RPC over stdin/stdout |
| License | MIT |
| Repo | GitHub (public) |

---

## Current Dev Priorities

1. **Backup parsing completeness** — ensure all major iPhone backup data types are extractable (Messages, Contacts, Photos, Notes, Health, etc.)
2. **IPC stability** — JSON-RPC message handling must be robust; guard against duplicate `tool_use` / request IDs, malformed responses, and sidecar crashes
3. **PyInstaller build pipeline** — the sidecar binary must bundle cleanly across platforms (Mac, Windows priority)
4. **UI polish** — file browser / extraction UI in React should be functional and clear
5. **Error handling** — surface Python sidecar errors meaningfully in the UI rather than silent failures

---

## Known Constraints & Gotchas

- **Duplicate JSON-RPC IDs will cause 400-level errors** — always generate unique IDs per request; do not reuse IDs within a session
- **stdin/stdout is the only channel** — do not attempt sockets or HTTP for sidecar communication
- The Python sidecar must handle its own exceptions and return well-formed JSON-RPC error objects rather than crashing
- PyInstaller bundles can have path issues with relative imports — use `sys._MEIPASS` for resource resolution inside the sidecar
- iPhone backup SQLite files use non-standard hashed filenames — the Manifest.db is the index; always parse it first

---

## Common Commands

```bash
# Install dependencies
npm install

# Run in development
npm run dev

# Build Python sidecar
pyinstaller --onefile sidecar/main.py

# Build Electron app
npm run build

# Run tests
npm test

# Corpus tests against real public iPhone backups (see corpus/README.md)
python -m corpus.fetch fetch pub-hickman-15.3.1
pytest python/tests/corpus -m corpus -v
```

*(Update these if scripts differ in package.json)*

---

## Project Goal (Keep in Mind)

This is an open-source public good. Prioritize:
- **Reliability** over feature breadth
- **Clear error messages** for non-technical users
- **Cross-platform compatibility** (Mac first, then Windows)
- **Zero cost to the end user** — no license checks, no paywalls, no telemetry
