# OpenExtract — Architecture

## Overview

OpenExtract is a modular, API-first open-source platform for extracting, analysing, and anonymising data from iPhone backups.

The architecture is a **uv monorepo** with independently installable Python packages and a React reference UI.

---

## Package Map

```
openextract/
  packages/
    openextract-core        iPhone backup reader + data extractors
    openextract-backup      Device-to-disk backup agent (pymobiledevice3)
    openextract-analyzer    Analysis engine + AI synthesis + report generation
    openextract-anonymize   PII redaction / pseudonymization + diff/approval API
    openextract-api         FastAPI server wiring all packages over HTTP + SSE
  apps/
    ui/                     React reference app / test harness
    desktop-legacy/         Archived Electron + JSON-RPC desktop app (v0.3.0)
  docs/
  pyproject.toml            uv workspace root
```

---

## Component Responsibilities

### `openextract-core`

The foundation. Opens encrypted and unencrypted backups, provides file access abstraction, and exposes typed Pydantic record sets for all supported data domains.

**Public API:**
```python
from openextract.core import Backup, discover_backups

backups = discover_backups()                         # find all backups
with Backup.open("/path/to/backup", password="...") as b:
    b.messages.list_conversations()                  # → list[Conversation]
    b.messages.get_messages(chat_id=1, limit=100)   # → list[Message]
    b.contacts.list_contacts()                       # → list[Contact]
    b.calls.list_calls()                             # → list[Call]
    b.voicemail.list_voicemails()                    # → list[Voicemail]
    b.notes.list_notes()                             # → list[Note]
    b.photos.list_albums()                           # → list[Album]
    b.photos.list_assets()                           # → list[Asset]
```

**Supported data domains:**

| Domain | Source DB | Encrypted required |
|---|---|---|
| Messages (SMS/iMessage) | `Library/SMS/sms.db` | No |
| Contacts | `Library/AddressBook/AddressBook.sqlitedb` | No |
| Call History | `Library/CallHistoryDB/CallHistory.storedata` | Yes |
| Voicemail | `Library/Voicemail/voicemail.db` | No |
| Notes | `NoteStore.sqlite` / legacy `notes.sqlite` | No |
| Photos & Videos | `Media/PhotoData/Photos.sqlite` | No |

---

### `openextract-backup`

Creates backups from connected iPhones using `pymobiledevice3`. Supports USB, Wi-Fi, and iOS 17+ RSD devices.

**Public API:**
```python
from openextract.backup import BackupAgent

agent = BackupAgent(output_dir="/backups")
async for event in agent.create(udid="abc123", encrypted=True, password="s3cr3t"):
    print(event.stage, event.progress, event.message)
```

All progress is surfaced as `Event` objects yielded from an async generator. The caller decides how to forward them.

---

### `openextract-analyzer`

Consumes raw record sets from `openextract-core` and produces three categories of output:

**1. Relationship Graph**
- Per-contact message volume, first/last contact, avg response time, communication style
- Ranked contact list by interaction frequency

**2. Timeline & Topic Analysis**
- TF-IDF topic clustering across all conversations
- Timeline event detection: high-activity bursts, silence gaps, new contacts
- Per-conversation topic labelling

**3. AI Synthesis**
- Token-budgeted distillation: conversations ranked by recency + contact importance, chunked to fit LLM context windows
- Structured JSON summary (overview, top contacts, communication stats)
- LLM-ready text chunks, pre-formatted and annotated

**Exportable reports:**
- Self-contained HTML report (dark-themed, no external dependencies)
- PDF via WeasyPrint (optional: `pip install openextract-analyzer[reports]`)

**Public API:**
```python
from openextract.analyzer import Analyzer

analyzer = Analyzer("/path/to/backup", password="optional")
async for event in analyzer.run(token_budget=100_000):
    print(event.progress, event.message)

result = analyzer.result()           # AnalysisResult
html   = analyzer.report_html()      # str
chunks = analyzer.ai_chunks(80_000)  # list[AIChunk]
```

---

### `openextract-anonymize`

Removes or replaces PII from any typed record set from `openextract-core`. Supports two strategies:

| Strategy | Behaviour |
|---|---|
| `redact` | Replaces with `[REDACTED_NAME]`, `[REDACTED_PHONE]`, `[REDACTED_EMAIL]` |
| `pseudonymize` | Replaces with consistent synthetic substitutes (same real value → same pseudonym) |

The diff manifest records every replacement and supports field-level or bulk approval before anonymised data is exposed.

**Public API:**
```python
from openextract.anonymize import Anonymizer

anon = Anonymizer(strategy="pseudonymize", contacts=contacts)
result = anon.process_messages(messages)

result.diff            # list[DiffEntry] — every replacement
result.summary()       # {total_replacements, approved, pending, by_entity_type}
result.approve_all()   # mark all as approved
result._anonymized     # list[Message] with PII replaced
```

**Side-by-side comparison** is exposed via the API's `/anonymize/{session}/compare` endpoint.

---

### `openextract-api`

FastAPI server that wires all packages behind a REST + SSE interface.

**Start the server:**
```bash
pip install openextract-api
openextract serve --host 0.0.0.0 --port 8000
```

**API surface:**

```
GET  /                          Health / meta
GET  /docs                      OpenAPI docs (Swagger UI)
GET  /health

# Backup management
GET  /backups/discover          Discover backups on disk
POST /backups/open              Open a backup session
GET  /backups/sessions          List open sessions
DEL  /backups/sessions/{key}    Close a session

# Raw data browsing
GET  /messages/conversations    List conversations
GET  /messages/conversations/{id}  Get messages
GET  /messages/search           Full-text search
GET  /contacts                  List contacts
GET  /calls                     List call history
GET  /voicemail                 List voicemails
GET  /voicemail/{id}/audio      Get voicemail audio
GET  /notes                     List notes
GET  /photos/albums             List albums
GET  /photos/assets             List photo assets
GET  /photos/assets/{hash}/thumbnail  Get thumbnail
GET  /photos/assets/{hash}/raw  Get raw bytes

# Analysis (SSE streaming)
GET  /analysis/{session}/run    Stream analysis progress (SSE)
GET  /analysis/{session}        Get stored analysis result
GET  /analysis/{session}/ai-chunks  Get LLM-ready chunks
GET  /analysis/{session}/report.html  HTML report
GET  /analysis/{session}/report.pdf   PDF report

# Anonymization + approval
POST /anonymize/{session}/process     Run anonymization
GET  /anonymize/{session}/diff        Get diff manifest
POST /anonymize/{session}/approve     Approve replacements
GET  /anonymize/{session}/anonymized  Get approved anonymized data
GET  /anonymize/{session}/compare     Side-by-side comparison
```

---

## Event System

All long-running operations yield `Event` objects:

```python
@dataclass
class Event:
    component: str    # 'backup' | 'analyzer'
    stage: str        # component-defined stage name
    progress: float   # 0.0 – 1.0
    message: str      # human-readable status
    detail: dict      # component-specific payload
    timestamp: datetime
```

Over the API, events are delivered as **Server-Sent Events (SSE)**:
```
data: {"component":"analyzer","stage":"clustering","progress":0.65,"message":"Clustering topics…"}
```

---

## Data Flow

```
iPhone
  │
  ▼ (pymobiledevice3)
[openextract-backup]
  │  BackupAgent.create() → async Event generator
  ▼
Backup on disk (encrypted or unencrypted)
  │
  ▼ (iphone-backup-decrypt + SQLite)
[openextract-core]
  │  Backup.open() → extractors → typed Pydantic models
  ├──────────────────────────────────────┐
  ▼                                      ▼
[openextract-analyzer]         [openextract-anonymize]
  │  Analyzer.run()              │  Anonymizer.process_*()
  │  → RelationshipGraph         │  → AnonymizationResult
  │  → TopicAnalysis             │  → diff manifest
  │  → AISynthesisResult         │  → approved anonymized data
  │  → HTML/PDF reports          │
  └──────────────┬───────────────┘
                 ▼
        [openextract-api]
          FastAPI + SSE
                 ▼
        [apps/ui] (React)
        or any HTTP consumer
```

---

## Development

```bash
# Install all packages in development mode
uv sync

# Start the API server
openextract serve --reload

# Start the UI (in apps/ui/)
npm install && npm run dev

# Run tests
pytest packages/

# Lint
ruff check packages/
```

---

## Vertical Integration

Any downstream application can compose the packages it needs:

```python
# Minimal: just browse raw data
from openextract.core import Backup
with Backup.open(path) as b:
    messages = b.messages.list_conversations()

# Full pipeline: extract → analyse → anonymise → synthesise for AI
from openextract.core import Backup
from openextract.analyzer import Analyzer
from openextract.anonymize import Anonymizer

analyzer = Analyzer(path)
async for event in analyzer.run(): ...

anon = Anonymizer("pseudonymize", contacts=contacts)
result = anon.process_messages(messages)
result.approve_all()

chunks = analyzer.ai_chunks(budget=80_000)
# → Pass to OpenAI / Anthropic / local LLM
```

---

## Versioning

Each package is versioned independently. The monorepo workspace pin ensures compatible versions during development. PyPI releases are handled per-package.

| Package | Version | PyPI |
|---|---|---|
| openextract-core | 0.1.0 | `pip install openextract-core` |
| openextract-backup | 0.1.0 | `pip install openextract-backup` |
| openextract-analyzer | 0.1.0 | `pip install openextract-analyzer` |
| openextract-anonymize | 0.1.0 | `pip install openextract-anonymize` |
| openextract-api | 0.1.0 | `pip install openextract-api` |
