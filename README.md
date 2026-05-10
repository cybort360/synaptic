# Synaptic

> A local-first AI dev companion powered by **Gemma 4** — remembers your coding journey, surfaces forgotten solutions, and warns you before your old habits break you in a new language.

Synaptic watches your development activity silently and builds a model of how *you specifically* think and solve problems. When you're stuck or learning something new, it translates patterns using your own code history as examples — not generic documentation.

Powered entirely by **[Gemma 4](https://deepmind.google/technologies/gemma/)** running locally via [Ollama](https://ollama.com). No API keys required. No data leaves your machine.

**Everything runs on your machine. Nothing leaves without your permission.**

---

## How it works

Every few seconds, Synaptic observes your environment:

- Files you save and edit
- Terminal commands you run and errors you hit
- Shell history for error pattern detection
- (macOS) Which app is in focus and how often you switch

Raw events are compressed by **Gemma 4** (running locally via Ollama) into structured memories: a summary, extracted concepts, a significance score, and a verbatim error + resolution if one was detected. These memories are stored in a local SQLite database and indexed for semantic search using `nomic-embed-text` embeddings.

When you ask a question, Synaptic retrieves the most relevant memories from your history, builds a context window, and reasons over it with Gemma 4 — answering with your own past solutions as the starting point, not generic knowledge.

```
Files / Terminal / Shell history
        ↓
    Observer (chokidar + history polling + stuck detector)
        ↓
    EventBus (decoupled, in-process)
        ↓
    Archivist (compress → embed → store in SQLite)
        ↓
    Connector (semantic search → build prompt → reason)
        ↓
    Dashboard / HUD
```

---

## Features

### Ambient activity timeline
Real-time feed of everything Synaptic has captured and compressed. Filter by type: all, code changes, errors, shell activity. Each entry shows the timestamp, file, summary, and extracted concepts.

### Ask anything about your own code history
Four query modes available from the dashboard:

| Mode | What it does |
|---|---|
| **Translate** | "How do I do X in [language]?" — finds your own past code doing the equivalent and maps the pattern across |
| **Explain** | Explains a new concept grounded in concepts you've actually worked with before |
| **Map Concept** | Maps a new library/keyword to the closest things in your history |
| **Find Solution** | Semantic search over past errors and fixes — "have I solved something like this before?" |

### Mentor Bridge
Paste an error message from any language. Synaptic explains it using your own coding history as the mental anchor — not generic documentation. Set your source and target language in config and the bridge uses that context automatically.

### Habit mismatch detection
Runs continuously in the background. When Synaptic detects a pattern from your history appearing in a new-language file where it won't work, it surfaces a warning. Proactive — doesn't wait for you to ask.

### Socratic gate
When `socraticMode` is enabled, Synaptic intercepts file opens for recognized code files and surfaces a targeted question before you start typing. The question is grounded in your own coding history — Gemma 27B reads your recent 24 hours of activity and asks you to articulate the specific approach you're about to take.

Two modes:
- **followup** (default) — Shows the question in the HUD. You can answer or skip. Non-blocking.
- **gate** — The HUD panel persists until your explanation satisfies Gemma. Blocking. Designed for structured learning or pair-review sessions.

Enable in config:
```json
"socraticMode": true,
"socraticStrictness": "followup"
```

Voice input works in the Socratic panel — press `Cmd+Shift+V` while the panel is focused.

### Stuck detection
Triggers automatically when two or more of these signals appear in a five-minute window:
- Three or more errors
- The same command run three or more times
- Six or more app switches
- The same file saved five or more times (thrashing)

Shows a banner with the detected signals and a shortcut to ask for help using that exact context.

### HUD overlay (Electron)
A small always-on-top overlay (`Cmd+Shift+S` to toggle) for quick queries without leaving your editor. Supports text and voice input. Renders markdown — headers, code blocks, tables.

### Voice input
`Cmd+Shift+V` to push-to-talk. Requires [whisper](https://github.com/openai/whisper) and [ffmpeg](https://ffmpeg.org) installed locally. Falls back gracefully if not available.

---

## Requirements

- **Node.js 20+**
- **[Ollama](https://ollama.com)** — local AI runtime that runs Gemma 4 on your machine (free)
- **[Gemma 4](https://deepmind.google/technologies/gemma/)** via Ollama — the model that powers everything: compression, vision, reasoning, and the Socratic engine
- **[ffmpeg](https://ffmpeg.org)** + **[whisper](https://github.com/openai/whisper)** — optional, for voice input only

---

## Installation

### Option A — Dashboard only (server mode)

```bash
git clone https://github.com/cybort360/synaptic
cd synaptic
npm install
```

Pull the three models Synaptic uses:

```bash
ollama pull gemma4:e4b         # compression, vision, and reasoning
ollama pull nomic-embed-text   # embeddings — semantic search over your memories
```

Copy the example config and edit it:

```bash
cp synaptic.config.example.json synaptic.config.json
```

Start the server:

```bash
npm run dev
```

Open the dashboard: [http://localhost:3777](http://localhost:3777)

On first launch, a setup wizard walks you through choosing what to watch and which directories to include. Nothing is observed until you explicitly configure it.

---

### Option B — Electron app (HUD + tray icon)

Same setup as above, then:

```bash
npm run electron
```

This starts both the server and the desktop overlay. The app lives in your menu bar. Use `Cmd+Shift+S` to toggle the HUD, `Cmd+Shift+V` for voice.

---

### Option C — Build for production

```bash
npm run build       # compiles TypeScript to dist/
npm start           # runs the compiled output
```

The Electron app automatically uses the compiled `dist/` if it exists, or falls back to `tsx` for development.

---

## Configuration

`synaptic.config.json` is created automatically on first run (from `synaptic.config.example.json`). It is gitignored — your settings stay local.

```json
{
  "watchPaths": ["/path/to/your/project"],
  "excludePatterns": [
    "**/node_modules/**",
    "**/.git/**",
    "**/*.env"
  ],
  "watchers": {
    "files": true,
    "terminal": true,
    "windows": true,
    "shellHistory": true
  },
  "fromLang": "",
  "toLang": "",
  "ollamaBaseUrl": "http://localhost:11434",
  "ollamaModel": "gemma4:e4b",
  "visionModel": "gemma4:e4b",
  "ollamaReasoningModel": "gemma4:e4b",
  "embeddingModel": "nomic-embed-text",
  "reasoningModelApiKey": "",
  "reasoningModelEndpoint": "https://generativelanguage.googleapis.com/v1beta",
  "reasoningModel": "gemini-2.0-flash",
  "dbPath": "./synaptic.db",
  "port": 3777,
  "retentionDays": {
    "low": 7,
    "medium": 30,
    "high": 365
  }
}
```

### Key fields

| Field | Description |
|---|---|
| `watchPaths` | Directories to watch. Empty array falls back to the current working directory. |
| `fromLang` / `toLang` | Optional. Set these to enable habit mismatch detection and the Mentor Bridge. Any language pair works — `"Python"` → `"Go"`, `"Java"` → `"Kotlin"`, etc. Leave empty to use Synaptic as a general memory tool. |
| `ollamaModel` | Fast model for event compression. Runs every few seconds. Default: `gemma4:4b`. |
| `visionModel` | Vision-capable model for reading terminal screenshots. Default: `gemma4:4b`. |
| `ollamaReasoningModel` | Reasoning model for queries, stuck detection, habit mismatch, Mentor Bridge, and the Socratic engine. Default: `gemma4:27b`. |
| `embeddingModel` | Embedding model for semantic search. Default: `nomic-embed-text`. |
| `reasoningModelApiKey` | Optional. Google AI Studio API key. When set, replaces `ollamaReasoningModel` with `gemini-2.0-flash` for the reasoning tier. The 4B compression and vision models always stay local. |
| `reasoningModel` | Cloud model used when `reasoningModelApiKey` is set. Default: `gemini-2.0-flash`. |
| `retentionDays` | Events are pruned by significance. Low-significance events kept 7 days, medium 30, high 365. |

### Environment variables

| Variable | Description |
|---|---|
| `AI_API_KEY` | Sets `reasoningModelApiKey`. Takes precedence over the config file. |
| `WATCH_PATHS` | Comma-separated list of paths to watch. Overrides `watchPaths` in config. |
| `SYNAPTIC_PORT` | Port to listen on. Fallback if `port` is not in config. |

---

## Powered by Gemma 4

Synaptic is built around **[Gemma 4](https://deepmind.google/technologies/gemma/)** — Google DeepMind's open model family, running entirely on your machine via Ollama. There are no cloud dependencies by default. Gemma 4 handles every AI task in the pipeline:

| Task | Model | When it runs |
|---|---|---|
| **Event compression** | `gemma4:e4b` | Every few seconds — turns raw file saves and terminal commands into structured memories |
| **Vision analysis** | `gemma4:e4b` | On terminal errors (macOS) — reads your screen to extract the exact error text |
| **Reasoning** | `gemma4:e4b` | On every query — translate, explain, map concept, stuck detection, socratic questions |
| **Embeddings** | `nomic-embed-text` | After compression — converts memories to vectors for semantic search |

Gemma 4's multimodal capability is what makes the vision pipeline possible — when you hit an error, Synaptic captures a screenshot and Gemma reads the actual stack trace off your screen before compressing the event.

**Cloud reasoning (optional):** You can swap the reasoning tier for Gemini 2.0 Flash via Google AI Studio for faster responses on slower machines. Gemma 4 always stays local for compression and vision regardless.

```bash
# Set in Settings → Reasoning Model → Cloud, or directly:
# "reasoningModelApiKey": "your-google-ai-studio-key" in synaptic.config.json
```

---

## Platform support

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| File watching | ✅ | ✅ | ✅ |
| Shell history (zsh/bash) | ✅ | ✅ | — |
| PowerShell history | — | — | ✅ |
| Terminal error detection | ✅ | ✅ | ✅ |
| Stuck detection | ✅ | ✅ | ✅ |
| Screen capture (for vision) | ✅ | — | — |
| Window/app monitoring | ✅ | — | — |
| Native folder picker | ✅ | — | — |
| Electron HUD | ✅ | ✅ | ✅ |

Features marked — degrade gracefully: the server still runs and all other features work. Linux and Windows contributors welcome — see [Contributing](#contributing).

---

## Architecture

### Observer

Watches the environment and emits raw events to the internal event bus.

- **FileWatcher** — [chokidar](https://github.com/paulmillr/chokidar)-based, debounced saves, detects create/edit/delete across configured directories
- **TerminalCapture** — polls shell history (zsh on macOS/Linux, bash fallback, PowerShell on Windows), pattern-matches for errors
- **WindowMonitor** — tracks active app via AppleScript (macOS only), categorizes by editor/terminal/browser/comms
- **StuckDetector** — behavioral analysis over a sliding five-minute window, emits stuck signals to trigger auto-assist

All modules communicate only through the event bus. No module talks to another directly.

### Archivist

Receives raw events, compresses them into structured memories, and persists everything.

- **Compressor** — calls the configured Ollama model to turn a raw event into a structured record: `summary`, `concepts[]`, `significance` (0–1), `error_verbatim`, `resolution`
- **Embedder** — feature-hash embeddings for semantic search (fast, local, no external model required)
- **SynapticDB** — SQLite via [sql.js](https://github.com/sql-js/sql.js), in-memory with periodic disk writes. Two tables: `events` and `connections`
- Significance-based retention: low `< 0.4` kept 7 days, medium 30 days, high `≥ 0.7` kept 365 days

### Connector

Retrieves relevant memories and reasons over them.

- **Reasoner** — two-tier: cloud API primary (if key set), Ollama local fallback
- **Prompts** — templates for connection-finding, stuck assistance, translation, habit mismatch detection, and concept mapping
- Query flow: semantic search → build context prompt → call model → stream tokens to UI

### Server

Express HTTP + WebSocket. The dashboard and HUD load from `src/ui/public/`. Config and watcher state are updated live via API — no restart required to add a watch path or toggle a feature.

---

## API reference

### Query endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/query` | `{ question, imageBase64? }` | Ask anything — streams SSE tokens |
| `POST` | `/api/bridge` | `{ error, lang, concepts?, imageBase64? }` | Mentor bridge — streams SSE tokens |
| `POST` | `/api/translate` | `{ question, fromLang?, toLang? }` | Translate a pattern between languages |
| `POST` | `/api/map-concept` | `{ concept }` | Map a new concept to known ones |
| `POST` | `/api/voice` | `{ audio (base64), mimeType }` | Transcribe audio via whisper |
| `POST` | `/api/socratic/respond` | `{ sessionId, answer }` | Submit an explanation to an active Socratic session |
| `POST` | `/api/socratic/skip` | `{ sessionId }` | Skip the current Socratic session |
| `GET` | `/api/socratic/session/:id` | — | Get full session history including Q&A turns |

### Data endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events/recent?hours=2` | Recent compressed events |
| `GET` | `/api/errors/unresolved` | Errors without a recorded resolution |
| `GET` | `/api/stats` | Counts: events, projects, habit mismatches, paused state |
| `GET` | `/api/projects` | Per-project event stats |
| `DELETE` | `/api/events?olderThanDays=N` | Clear events older than N days (omit to clear all) |

### Config endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Current config |
| `POST` | `/api/config` | Patch config (partial update, persisted to disk) |
| `POST` | `/api/pause` | Pause all observation |
| `POST` | `/api/resume` | Resume observation |
| `POST` | `/api/browse-directory` | Open native folder picker (macOS only) |

### WebSocket

Connect to `ws://localhost:3777`. Messages are JSON with a `type` and `data` field.

| Type | Direction | Payload |
|---|---|---|
| `new_event` | server → client | `CompressedEvent` |
| `stuck_detected` | server → client | `{ file, duration, signals[] }` |
| `habit_mismatch` | server → client | `{ pattern, oldLang, newLang, warning, trapType }` |
| `query_result` | server → client | `QueryResult` |
| `stats` | server → client | `{ totalEvents, projects, habitMismatches, paused }` |
| `observer_status` | server → client | `{ watchers: Record<string, "active" \| "paused" \| "error"> }` |

---

## Project structure

```
synaptic/
├── electron/
│   └── main.cjs                    # Electron main process — tray, HUD window, server spawn
│
├── src/
│   ├── index.ts                    # Entry point — wires up all modules, loads config
│   ├── server.ts                   # Express + WebSocket server
│   │
│   ├── observer/
│   │   ├── index.ts                # Starts and stops all watchers
│   │   ├── file-watcher.ts         # chokidar file change detection
│   │   ├── terminal-capture.ts     # Shell history polling + error pattern matching
│   │   ├── window-monitor.ts       # Active app tracking (macOS)
│   │   ├── stuck-detector.ts       # Behavioral stuck signal analysis
│   │   └── screen-capture.ts       # Screenshot via screencapture (macOS)
│   │
│   ├── archivist/
│   │   ├── index.ts                # Orchestrates compression pipeline
│   │   ├── compressor.ts           # Raw event → structured memory via Ollama
│   │   ├── embeddings.ts           # Feature-hash embeddings for semantic search
│   │   └── db.ts                   # SQLite (sql.js) — events + connections tables
│   │
│   ├── connector/
│   │   ├── index.ts                # Query handler, habit check loop
│   │   ├── reasoner.ts             # Two-tier reasoning: cloud API + Ollama fallback
│   │   └── prompts.ts              # All prompt templates
│   │
│   ├── mentor/
│   │   └── bridge-engine.ts        # Mentor Bridge — explains errors via coding history
│   │
│   └── shared/
│       ├── types.ts                # All interfaces, SynapticConfig, DEFAULT_CONFIG
│       ├── event-bus.ts            # In-process pub/sub between modules
│       └── ollama-client.ts        # Ollama HTTP API client
│
├── src/ui/public/
│   ├── index.html                  # Dashboard (vanilla JS, no framework)
│   └── hud.html                    # HUD overlay (Electron)
│
├── synaptic.config.example.json    # Config template — copy to synaptic.config.json
├── synaptic.config.json            # Your config (gitignored)
├── synaptic.db                     # SQLite database (gitignored)
├── package.json
└── tsconfig.json
```

---

## Privacy

Synaptic is designed to be explicit about what it observes and where data goes.

**What stays on your machine:**
- All events are stored in local SQLite (`synaptic.db`) only
- All embeddings are computed locally using feature hashing
- All event compression runs via your local Ollama model
- Shell history is read-only — never modified
- No telemetry, no analytics, no external network calls unless you explicitly set an API key

**What leaves your machine (only if you set `reasoningModelApiKey`):**
- The compressed reasoning prompt — a structured summary of your recent activity, not raw file contents or full code. Raw source code is never sent; only the compressed summaries that the local model already produced.

The first-run wizard makes this explicit and nothing is observed until you confirm your settings.

---

## Contributing

Pull requests welcome. This is built in public — issues, feedback, and ideas are all useful.

### Getting started

```bash
git clone https://github.com/cybort360/synaptic
cd synaptic
npm install
cp synaptic.config.example.json synaptic.config.json
npm run dev
```

### Development workflow

```bash
npm run dev       # tsx watch mode — restarts on source changes
npm run build     # compile TypeScript to dist/
npm run electron  # Electron app (uses dist/ if built, tsx if not)
```

### Areas that need work

- **Linux window monitoring** — `window-monitor.ts` uses AppleScript (macOS only). A `xdotool` or `wmctrl` implementation for Linux X11/Wayland would be a great addition.
- **Windows window monitoring** — same gap, needs a PowerShell or Win32 API approach.
- **Embeddings** — uses `nomic-embed-text` via Ollama by default. Falls back to feature hashing in `embeddings.ts` if the model is unavailable or not pulled.
- **Tests** — there are none. The core pipeline (compress → embed → store → retrieve → reason) is the right place to start.
- **Model benchmarks** — compression quality varies significantly by model. Documenting which models produce the best structured output would help new users choose.

### Code conventions

- TypeScript, ESM only (`"type": "module"` in package.json)
- No frameworks — Express, ws, chokidar, sql.js, that's it
- UI is vanilla JS/HTML — no build step, no bundler
- New modules emit events to `EventBus`, never call other modules directly
- Config-driven — nothing hardcoded that a user might want to change

---

## License

MIT
