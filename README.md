# Synaptic

> The AI dev tool that makes you explain yourself before you write a line of code.

Most AI tools write code *for* you. Synaptic asks *why* first.

Before you touch a file, Synaptic intercepts you and asks you to articulate your intent, grounded in your own coding history. If your explanation doesn't hold up, it asks a follow-up. When it does, you're free to code. The result: you stop copy-pasting patterns you don't understand and start building real knowledge that sticks.

This is the **Socratic gate**, the core of what Synaptic is.

Beyond that, Synaptic watches your entire development environment silently and builds a model of how *you specifically* think and solve problems. When you're stuck or learning a new language, it surfaces your own past solutions instead of generic documentation pulled from the internet.

Powered entirely by **[Gemma 4](https://deepmind.google/technologies/gemma/)** running locally via [Ollama](https://ollama.com). No subscription. No cloud. No data leaves your machine.

---

**Live demo:** [https://synaptic-ebon.vercel.app](https://synaptic-ebon.vercel.app)

## How it works

Every few seconds, Synaptic observes your environment:

- Files you save and edit
- Terminal commands you run and errors you hit
- Shell history for error pattern detection
- (macOS) Which app is in focus and how often you switch

Raw events are compressed by **Gemma 4** (running locally via Ollama) into structured memories: a summary, extracted concepts, a significance score, and a verbatim error + resolution if one was detected. These memories are stored in a local SQLite database and indexed for semantic search using `nomic-embed-text` embeddings.

When you ask a question, Synaptic retrieves the most relevant memories from your history, builds a context window, and reasons over it with Gemma 4, answering with your own past solutions as the starting point rather than generic knowledge.

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

## Synaptic vs GitHub Copilot

These are not competing tools. They solve different problems. Copilot writes code *for* you. Synaptic helps you *become* a better developer by understanding how you specifically think and where you get stuck.

| | Synaptic | GitHub Copilot |
|---|---|---|
| **Memory** | Remembers your full coding history across every session | No persistent memory. Each session starts from zero |
| **Context** | Your entire dev environment: files, terminal, errors, app switches | Only the file currently open in your editor |
| **Privacy** | 100% local. Code never leaves your machine | Code sent to Microsoft/GitHub servers for processing |
| **Cost** | Free. Runs on open-source Gemma 4 via Ollama | $10–$19/month subscription |
| **Language learning** | Built for it. Grounds explanations in your existing knowledge | Gives generic suggestions regardless of your background |
| **Habit detection** | Warns you when you apply patterns from your old language that break in your new one | No awareness of language habits or migration paths |
| **Stuck detection** | Detects when you're spinning (repeated errors, thrashing, app switching) and proactively surfaces help | Passive. Only responds when you invoke it |
| **Error memory** | Tracks every error you hit and how you resolved it, surfacing the fix next time | No error history |
| **Learning mode** | Socratic gate that asks you to explain your intent before writing code, building real understanding | Writes code for you, which can create copy-paste dependency |
| **Vendor lock-in** | Editor-agnostic, works with any workflow, any OS | Requires GitHub, works best in VS Code |
| **Data ownership** | SQLite database on your machine, you own it entirely | Training and history handled by Microsoft |

### The five things Copilot fundamentally cannot do

**1. Remember yesterday.**
Every time you open VS Code, Copilot starts from nothing. Synaptic accumulates knowledge about your patterns across weeks and months. When you hit an error you've seen before, Synaptic remembers exactly how you solved it last time. Copilot has no record of it.

**2. Know when you're stuck before you ask.**
Copilot waits for you to invoke it. Synaptic watches for signals: three errors in five minutes, the same command run repeatedly, excessive file saves. It surfaces help before you lose the thread. You don't have to know you need help to get it.

**3. Warn you that your habit is about to break.**
If you're a JavaScript developer learning Rust and you reach for `try/catch`, Synaptic flags it. It knows your background and actively detects when you're applying a pattern from your old language that will fail in your new one. This is the mistake Copilot would happily autocomplete for you.

**4. Ground answers in your code, not the internet's code.**
When you ask Copilot "how do I handle errors in Rust?", it answers from its training data. When you ask Synaptic the same thing, it finds the three times you've handled errors in your own code, and explains the Rust equivalent using those specific examples. The answer feels like it came from a colleague who has been watching you work. Because it did.

**5. Keep your code private by design.**
Copilot's value comes from training on billions of lines of code, and it processes your queries on Microsoft's servers. Synaptic runs Gemma 4 locally. Your code, your errors, your history: none of it leaves your machine. This is non-negotiable for developers working on proprietary systems or under NDA.

---

## Features

### ⟶ Socratic gate: the headline feature

When you open a code file, Synaptic stops you before you type. It reads your last 24 hours of coding activity, identifies what concept or decision is most at stake in this specific file, and asks you one targeted question:

> *"You've been using closures heavily in JavaScript. Before you open this Rust file: how are you planning to handle the fact that Rust doesn't have garbage collection?"*

The question isn't generic. It's built from your actual history. Gemma 4 looks at what you've been building, what errors you've hit, and what concepts you've been wrestling with, then asks the one thing most likely to reveal whether you actually understand what you're about to do.

**Two modes:**

| Mode | Behaviour | Best for |
|---|---|---|
| **Follow-up** | Question appears in the HUD. Answer or skip. Non-blocking. | Daily learning mode |
| **Gate** | HUD persists until Gemma accepts your explanation. Cannot skip. | Structured study, interview prep, pair review |

**Gemma 4 evaluates your answer.** If it's vague ("I'll figure it out as I go"), it asks a sharper follow-up targeting exactly what you glossed over. If it's solid, it lets you through and the session is logged. Over time, your explanations get better. You have been forced to think before you type, every single day.

Enable in Settings → **Socratic Gate**, or directly:
```json
"socraticMode": true,
"socraticStrictness": "followup"
```

Voice input works in the Socratic panel. Press `Cmd+Shift+V` while the panel is focused.

---

### Ambient activity timeline
Real-time feed of everything Synaptic has captured and compressed. Filter by type: all, code changes, errors, shell activity. Each entry shows the timestamp, file, summary, and extracted concepts.

### Ask anything about your own code history
Four query modes available from the dashboard:

| Mode | What it does |
|---|---|
| **Translate** | "How do I do X in [language]?" Finds your own past code doing the equivalent and maps the pattern across |
| **Explain** | Explains a new concept grounded in concepts you've actually worked with before |
| **Map Concept** | Maps a new library/keyword to the closest things in your history |
| **Find Solution** | Semantic search over past errors and fixes. Asks: "have I solved something like this before?" |

### Mentor Bridge
Paste an error message from any language. Synaptic explains it using your own coding history as the mental anchor, not generic documentation. Set your source and target language in config and the bridge uses that context automatically.

### Habit mismatch detection
Runs continuously in the background. When Synaptic detects a pattern from your history appearing in a new-language file where it won't work, it surfaces a warning immediately. It never waits for you to ask.

### Stuck detection
Triggers automatically when two or more of these signals appear in a five-minute window:
- Three or more errors
- The same command run three or more times
- Six or more app switches
- The same file saved five or more times (thrashing)

Shows a banner with the detected signals and a shortcut to ask for help using that exact context.

### HUD overlay (Electron)
A small always-on-top overlay (`Cmd+Shift+S` to toggle) for quick queries without leaving your editor. Supports text and voice input. Renders markdown: headers, code blocks, tables.

### Voice input
`Cmd+Shift+V` to push-to-talk. Requires [whisper](https://github.com/openai/whisper) and [ffmpeg](https://ffmpeg.org) installed locally. Falls back gracefully if not available.

---

## Requirements

- **Node.js 20+**
- **[Ollama](https://ollama.com)**: local AI runtime that runs Gemma 4 on your machine (free)
- **[Gemma 4](https://deepmind.google/technologies/gemma/)** via Ollama: the model that powers compression, vision, reasoning, and the Socratic engine
- **[ffmpeg](https://ffmpeg.org)** + **[whisper](https://github.com/openai/whisper)**: optional, for voice input only

---

## Installation

### Option A: Dashboard only (server mode)

```bash
git clone https://github.com/cybort360/synaptic
cd synaptic
npm install
```

Pull the three models Synaptic uses:

```bash
ollama pull gemma4:e4b         # compression, vision, and reasoning
ollama pull nomic-embed-text   # embeddings for semantic search over your memories
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

### Option B: Electron app (HUD + tray icon)

Same setup as above, then:

```bash
npm run electron
```

This starts both the server and the desktop overlay. The app lives in your menu bar. Use `Cmd+Shift+S` to toggle the HUD, `Cmd+Shift+V` for voice.

---

### Option C: Build for production

```bash
npm run build       # compiles TypeScript to dist/
npm start           # runs the compiled output
```

The Electron app automatically uses the compiled `dist/` if it exists, or falls back to `tsx` for development.

---

## Configuration

`synaptic.config.json` is created automatically on first run (from `synaptic.config.example.json`). It is gitignored so your settings stay local.

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
| `fromLang` / `toLang` | Optional. Set these to enable habit mismatch detection and the Mentor Bridge. Any language pair works: `"Python"` → `"Go"`, `"Java"` → `"Kotlin"`, etc. Leave empty to use Synaptic as a general memory tool. |
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

Synaptic is built around **[Gemma 4](https://deepmind.google/technologies/gemma/)** is Google DeepMind's open model family, running entirely on your machine via Ollama. There are no cloud dependencies by default. Gemma 4 handles every AI task in the pipeline:

| Task | Model | When it runs |
|---|---|---|
| **Event compression** | `gemma4:e4b` | Runs every few seconds, turning raw file saves and terminal commands into structured memories |
| **Vision analysis** | `gemma4:e4b` | On terminal errors (macOS), reads your screen to extract the exact error text |
| **Reasoning** | `gemma4:e4b` | On every query: translate, explain, map concept, stuck detection, Socratic questions |
| **Embeddings** | `nomic-embed-text` | After compression, converts memories to vectors for semantic search |

Gemma 4's multimodal capability is what makes the vision pipeline possible. When you hit an error, Synaptic captures a screenshot and Gemma reads the actual stack trace off your screen before compressing the event.

**Cloud reasoning (optional):** You can swap the reasoning tier for Gemini 2.0 Flash via Google AI Studio for faster responses on slower machines. Gemma 4 always stays local for compression and vision regardless.

```bash
# Set in Settings → Reasoning Model → Cloud, or directly:
# "reasoningModelApiKey": "your-google-ai-studio-key" in synaptic.config.json
```

### Why `gemma4:e4b` specifically

The `e4b` model (4B effective parameters) was a deliberate choice, not a default.

**Speed is the constraint.** Synaptic compresses every file save and terminal command into a structured memory, running a compression pass every few seconds in the background while you code. A larger model would create a backlog. With `gemma4:e4b`, compression completes before the next event arrives. The 3-second batch cycle stays clean.

**Multimodal was the unlock.** When you hit a terminal error on macOS, Synaptic captures a screenshot and sends it to Gemma before compression. Gemma reads the actual stack trace off your screen rather than the shell history, which often truncates. This is only possible with a vision-capable model. A text-only 4B model can't do it. A vision-capable model too large to run locally can't do it. `gemma4:e4b` is the intersection: fast, local, and genuinely multimodal.

**What breaks with a different model:**

| Alternative | What fails |
|---|---|
| A 27B local model | Compression batches pile up. The 3-second cycle becomes 30+ seconds and memories fall behind real activity |
| A non-multimodal 4B | Vision pipeline silently degrades. Errors are compressed without reading the actual screen output |
| A cloud-only model | The entire privacy guarantee breaks. Code, errors, and history leave your machine |
| No local model at all | Socratic gate cannot fire on every file save. Latency makes it unusable as a real-time feature |

The Socratic gate in particular depends on this: it fires within 1.5 seconds of a file save, generates a personalised question, and streams it word-by-word to the HUD. That loop only works because `gemma4:e4b` is fast enough to start generating before the developer has finished opening their editor.

---

## Platform support

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| File watching | ✅ | ✅ | ✅ |
| Shell history (zsh/bash) | ✅ | ✅ | - |
| PowerShell history | - | - | ✅ |
| Terminal error detection | ✅ | ✅ | ✅ |
| Stuck detection | ✅ | ✅ | ✅ |
| Screen capture (for vision) | ✅ | - | - |
| Window/app monitoring | ✅ | - | - |
| Native folder picker | ✅ | - | - |
| Electron HUD | ✅ | ✅ | ✅ |

Features marked degrade gracefully: the server still runs and all other features work.

---

## Architecture

### Observer

Watches the environment and emits raw events to the internal event bus.

- **FileWatcher**: [chokidar](https://github.com/paulmillr/chokidar)-based, debounced saves, detects create/edit/delete across configured directories
- **TerminalCapture**: polls shell history (zsh on macOS/Linux, bash fallback, PowerShell on Windows), pattern-matches for errors
- **WindowMonitor**: tracks active app via AppleScript (macOS only), categorizes by editor/terminal/browser/comms
- **StuckDetector**: behavioral analysis over a sliding five-minute window, emits stuck signals to trigger auto-assist

All modules communicate only through the event bus. No module talks to another directly.

### Archivist

Receives raw events, compresses them into structured memories, and persists everything.

- **Compressor**: calls the configured Ollama model to turn a raw event into a structured record: `summary`, `concepts[]`, `significance` (0–1), `error_verbatim`, `resolution`
- **Embedder**: feature-hash embeddings for semantic search (fast, local, no external model required)
- **SynapticDB**: SQLite via [sql.js](https://github.com/sql-js/sql.js), in-memory with periodic disk writes. Two tables: `events` and `connections`
- Significance-based retention: low `< 0.4` kept 7 days, medium 30 days, high `≥ 0.7` kept 365 days

### Connector

Retrieves relevant memories and reasons over them.

- **Reasoner**: two-tier — cloud API primary (if key set), Ollama local fallback
- **Prompts**: templates for connection-finding, stuck assistance, translation, habit mismatch detection, and concept mapping
- Query flow: semantic search → build context prompt → call model → stream tokens to UI

### Server

Express HTTP + WebSocket. The dashboard and HUD load from `src/ui/public/`. Config and watcher state are updated live via the API. No restart required to add a watch path or toggle a feature.

---

## API reference

### Query endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/query` | `{ question, imageBase64? }` | Ask anything, streams SSE tokens |
| `POST` | `/api/bridge` | `{ error, lang, concepts?, imageBase64? }` | Mentor bridge, streams SSE tokens |
| `POST` | `/api/translate` | `{ question, fromLang?, toLang? }` | Translate a pattern between languages |
| `POST` | `/api/map-concept` | `{ concept }` | Map a new concept to known ones |
| `POST` | `/api/voice` | `{ audio (base64), mimeType }` | Transcribe audio via whisper |
| `POST` | `/api/socratic/respond` | `{ sessionId, answer }` | Submit an explanation to an active Socratic session |
| `POST` | `/api/socratic/skip` | `{ sessionId }` | Skip the current Socratic session |
| `GET` | `/api/socratic/session/:id` | - | Get full session history including Q&A turns |

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
│   └── main.cjs                    # Electron main process: tray, HUD window, server spawn
│
├── src/
│   ├── index.ts                    # Entry point: wires up all modules, loads config
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
│   │   └── db.ts                   # SQLite (sql.js): events + connections tables
│   │
│   ├── connector/
│   │   ├── index.ts                # Query handler, habit check loop
│   │   ├── reasoner.ts             # Two-tier reasoning: cloud API + Ollama fallback
│   │   └── prompts.ts              # All prompt templates
│   │
│   ├── mentor/
│   │   └── bridge-engine.ts        # Mentor Bridge: explains errors via coding history
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
├── synaptic.config.example.json    # Config template: copy to synaptic.config.json
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
- Shell history is read-only and never modified
- No telemetry, no analytics, no external network calls unless you explicitly set an API key

**What leaves your machine (only if you set `reasoningModelApiKey`):**
- The compressed reasoning prompt is a structured summary of your recent activity, not raw file contents or full code. Raw source code is never sent; only the compressed summaries that the local model already produced.

The first-run wizard makes this explicit and nothing is observed until you confirm your settings.

---


### Code conventions

- TypeScript, ESM only (`"type": "module"` in package.json)
- No frameworks. Express, ws, chokidar, sql.js, that's it
- UI is vanilla JS/HTML with no build step and no bundler
- New modules emit events to `EventBus`, never call other modules directly
- Config-driven. Nothing hardcoded that a user might want to change

---

## License

MIT
