# Socratic Engine — Implementation Specification

## Overview

Add a "think before you type" layer to Synaptic. When a developer opens a code file, the system surfaces a Gemma 27B–generated question based on their history asking them to explain their intent. The HUD shows the question, accepts a typed or voice response, and Gemma evaluates the quality of the explanation before letting them proceed. This runs through the existing Archivist memory pipeline and WebSocket broadcast infrastructure.

This document is a complete implementation spec. Every file is described in full. Do not deviate from the existing code conventions: TypeScript, ESM only, no frameworks, EventBus for all inter-module communication.

---

## Architecture Summary

```
FileWatcher (file_open event)
    ↓ emitSocraticGate()
EventBus
    ↓ onSocraticGate()
Connector → SocraticEngine
    → pulls 24h context from Archivist
    → calls Gemma 27B to generate opening question
    ↓ emitSocraticQuestion()
EventBus
    ↓ server.ts onSocraticQuestion()
WebSocket broadcast → HUD
    ↓ developer types explanation
POST /api/socratic/respond
    → SocraticEngine evaluates response
    → either emits follow-up question or emits socratic_complete
```

---

## 1. Config Changes

### `synaptic.config.example.json`

Add two new fields at the top level alongside the existing fields:

```json
"socraticMode": false,
"socraticStrictness": "followup"
```

`socraticMode`: boolean. When false, the entire Socratic system is dormant — no file_open hooks fire, no questions are generated. Default `false` so existing users are not surprised on upgrade.

`socraticStrictness`: string enum, two valid values:
- `"followup"` — HUD shows question and evaluates response, but the developer can dismiss it and keep coding. Non-blocking. Good for learning mode.
- `"gate"` — The HUD persists and cannot be dismissed until Gemma marks the explanation as satisfactory. Blocking. Good for structured teaching.

---

## 2. Type Changes

### `src/shared/types.ts`

Add the following to the `SynapticConfig` interface (alongside existing fields):

```typescript
socraticMode: boolean;
socraticStrictness: "followup" | "gate";
```

Add to `DEFAULT_CONFIG`:

```typescript
socraticMode: false,
socraticStrictness: "followup",
```

Add these new interfaces at the end of the file (before the closing):

```typescript
export interface SocraticSession {
  id: string;                   // randomUUID()
  filePath: string;             // the file that was opened
  fileLanguage: string | null;  // detected language, e.g. "TypeScript", null if unknown
  openedAt: string;             // ISO timestamp
  history: SocraticTurn[];      // full Q&A history in order
  status: "open" | "passed" | "skipped";
  relevantConcepts: string[];   // concepts pulled from Archivist for this file
}

export interface SocraticTurn {
  role: "question" | "answer" | "evaluation";
  content: string;
  timestamp: string;
}

export interface SocraticGateEvent {
  filePath: string;
  fileLanguage: string | null;
  triggerType: "file_open";
}

export interface SocraticQuestionEvent {
  sessionId: string;
  filePath: string;
  question: string;
  turnIndex: number;           // 0 = opening question, 1+ = follow-ups
  isFollowUp: boolean;
}

export interface SocraticResultEvent {
  sessionId: string;
  passed: boolean;
  feedback: string;            // the model's final evaluation text
  totalTurns: number;
}
```

---

## 3. EventBus Changes

### `src/shared/event-bus.ts`

Import the new types at the top:

```typescript
import type {
  RawEvent, CompressedEvent, QueryResult, HabitMismatch, ObserverStatus,
  SocraticGateEvent, SocraticQuestionEvent, SocraticResultEvent
} from "./types.js";
```

Add six new methods to the `SynapticEventBus` class body, in the same pattern as the existing ones:

```typescript
emitSocraticGate(event: SocraticGateEvent) { this.emit("socratic_gate", event); }
emitSocraticQuestion(event: SocraticQuestionEvent) { this.emit("socratic_question", event); }
emitSocraticResult(event: SocraticResultEvent) { this.emit("socratic_result", event); }

onSocraticGate(handler: (event: SocraticGateEvent) => void) { this.on("socratic_gate", handler); }
onSocraticQuestion(handler: (event: SocraticQuestionEvent) => void) { this.on("socratic_question", handler); }
onSocraticResult(handler: (event: SocraticResultEvent) => void) { this.on("socratic_result", handler); }
```

---

## 4. FileWatcher Change

### `src/observer/file-watcher.ts`

Read the existing file first to understand its structure. Find where it handles `file_open` events and emits to the EventBus. After the existing `emitRawEvent()` call for a `file_open`, add a Socratic gate trigger:

```typescript
import { eventBus } from "../shared/event-bus.js";
import { BridgeEngine } from "../mentor/bridge-engine.js";  // already has detectLang()

// Inside the file_open handler, after emitting the raw event:
if (config.socraticMode) {
  const fileLanguage = BridgeEngine.detectLang(filePath);
  const isCodeFile = fileLanguage !== null;
  if (isCodeFile) {
    eventBus.emitSocraticGate({
      filePath,
      fileLanguage,
      triggerType: "file_open",
    });
  }
}
```

**Important**: The `config` reference must be passed in to the FileWatcher. Check the existing constructor signature — if config is not already passed in, add it. The `BridgeEngine.detectLang()` static method is already written and covers all languages in `LANG_EXTENSIONS`. Only emit the gate for files whose language is recognized (i.e. `detectLang` returns non-null). Never emit for `node_modules`, `.git`, or any path matching the existing `excludePatterns`.

---

## 5. New File: `src/mentor/socratic-engine.ts`

Create this file from scratch. It is the core of the feature.

```typescript
import { randomUUID } from "crypto";
import type { Archivist } from "../archivist/index.js";
import type { Reasoner } from "../connector/reasoner.js";
import type {
  SynapticConfig,
  SocraticSession,
  SocraticTurn,
  SocraticGateEvent,
  SocraticQuestionEvent,
  SocraticResultEvent,
} from "../shared/types.js";
import { eventBus } from "../shared/event-bus.js";
import { buildSocraticPrompt, buildSocraticEvalPrompt } from "../connector/prompts.js";

const MAX_TURNS = 3; // max follow-up questions before auto-passing

export class SocraticEngine {
  private sessions = new Map<string, SocraticSession>();

  constructor(
    private archivist: Archivist,
    private reasoner: Reasoner,
    private config: SynapticConfig
  ) {}

  /**
   * Called when a file_open fires for a recognized code file.
   * Pulls history, generates the opening question, stores the session.
   */
  async startSession(gate: SocraticGateEvent): Promise<void> {
    if (!this.config.socraticMode) return;

    const sessionId = randomUUID();
    const history: SocraticTurn[] = [];

    // Pull 24h context and semantic memories for this file
    const recentContext = this.archivist.getActiveContext(24);
    const fileMemories = await this.archivist.semanticSearch(gate.filePath, 8);

    // Collect concepts the developer has worked with recently
    const relevantConcepts = [
      ...new Set([
        ...recentContext.flatMap((e) => e.concepts),
        ...fileMemories.flatMap((e) => e.concepts),
      ]),
    ].slice(0, 20);

    // Build the opening question prompt
    const prompt = buildSocraticPrompt({
      filePath: gate.filePath,
      fileLanguage: gate.fileLanguage,
      recentContext,
      fileMemories,
      conversationHistory: [],
      developerAnswer: null,
    });

    let question: string;
    try {
      question = await this.reasoner.reason(prompt);
      // Strip any preamble — the prompt asks for just the question
      question = question.trim();
    } catch {
      // If the model call fails, don't block the developer
      console.warn("[Socratic] Failed to generate opening question, skipping session");
      return;
    }

    const turn: SocraticTurn = {
      role: "question",
      content: question,
      timestamp: new Date().toISOString(),
    };
    history.push(turn);

    const session: SocraticSession = {
      id: sessionId,
      filePath: gate.filePath,
      fileLanguage: gate.fileLanguage,
      openedAt: new Date().toISOString(),
      history,
      status: "open",
      relevantConcepts,
    };

    this.sessions.set(sessionId, session);

    // Broadcast to HUD
    const questionEvent: SocraticQuestionEvent = {
      sessionId,
      filePath: gate.filePath,
      question,
      turnIndex: 0,
      isFollowUp: false,
    };
    eventBus.emitSocraticQuestion(questionEvent);

    console.log(`[Socratic] Session ${sessionId} started for ${gate.filePath}`);
  }

  /**
   * Called when the developer submits an explanation via the HUD.
   * Evaluates the response. If satisfactory, closes the session.
   * If not, generates a follow-up question (up to MAX_TURNS).
   */
  async respondToSession(sessionId: string, developerAnswer: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open") return;

    const answerTurn: SocraticTurn = {
      role: "answer",
      content: developerAnswer,
      timestamp: new Date().toISOString(),
    };
    session.history.push(answerTurn);

    const questionCount = session.history.filter((t) => t.role === "question").length;

    // Pull fresh context for evaluation
    const recentContext = this.archivist.getActiveContext(24);
    const fileMemories = await this.archivist.semanticSearch(session.filePath, 8);

    const evalPrompt = buildSocraticEvalPrompt({
      filePath: session.filePath,
      fileLanguage: session.fileLanguage,
      recentContext,
      fileMemories,
      conversationHistory: session.history,
      developerAnswer,
    });

    let evalRaw: string;
    try {
      evalRaw = await this.reasoner.reason(evalPrompt);
    } catch {
      // On model failure, pass the session silently
      this.closeSession(session, true, "Model unavailable — session auto-passed.");
      return;
    }

    // Parse model response — expects JSON: { passed: boolean, feedback: string, followUp?: string }
    let passed = false;
    let feedback = "";
    let followUp: string | undefined;

    try {
      const jsonMatch = evalRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          passed: boolean;
          feedback: string;
          followUp?: string;
        };
        passed = Boolean(parsed.passed);
        feedback = String(parsed.feedback || "");
        followUp = parsed.followUp;
      }
    } catch {
      // If JSON parse fails, check for obvious positive signals
      passed = /\b(correct|good|yes|solid|clear|right|great)\b/i.test(evalRaw);
      feedback = evalRaw.slice(0, 300);
    }

    const evalTurn: SocraticTurn = {
      role: "evaluation",
      content: feedback,
      timestamp: new Date().toISOString(),
    };
    session.history.push(evalTurn);

    if (passed || questionCount >= MAX_TURNS) {
      this.closeSession(session, true, feedback);
    } else if (followUp) {
      // Ask follow-up
      const followUpTurn: SocraticTurn = {
        role: "question",
        content: followUp,
        timestamp: new Date().toISOString(),
      };
      session.history.push(followUpTurn);

      const questionEvent: SocraticQuestionEvent = {
        sessionId,
        filePath: session.filePath,
        question: followUp,
        turnIndex: questionCount,
        isFollowUp: true,
      };
      eventBus.emitSocraticQuestion(questionEvent);
    } else {
      // Evaluation said not passed but gave no follow-up — close anyway
      this.closeSession(session, false, feedback);
    }
  }

  /**
   * Developer clicks "Skip" in the HUD. Marks session as skipped.
   * In "gate" strictness this should be disallowed by the UI, not here.
   */
  skipSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = "skipped";
    const result: SocraticResultEvent = {
      sessionId,
      passed: false,
      feedback: "Session skipped.",
      totalTurns: session.history.filter((t) => t.role === "question").length,
    };
    eventBus.emitSocraticResult(result);
    console.log(`[Socratic] Session ${sessionId} skipped.`);
  }

  getSession(sessionId: string): SocraticSession | undefined {
    return this.sessions.get(sessionId);
  }

  private closeSession(session: SocraticSession, passed: boolean, feedback: string): void {
    session.status = passed ? "passed" : "skipped";
    const result: SocraticResultEvent = {
      sessionId: session.id,
      passed,
      feedback,
      totalTurns: session.history.filter((t) => t.role === "question").length,
    };
    eventBus.emitSocraticResult(result);
    console.log(`[Socratic] Session ${session.id} closed — passed=${passed}`);
  }
}
```

---

## 6. New Prompts

### `src/connector/prompts.ts`

Add these two new exported functions at the end of the file. Do not modify any existing functions.

First, define a shared input type at the top of the file (or inline the params — either is fine):

```typescript
// Shared input shape for both Socratic prompt builders
interface SocraticPromptInput {
  filePath: string;
  fileLanguage: string | null;
  recentContext: CompressedEvent[];
  fileMemories: CompressedEvent[];
  conversationHistory: { role: string; content: string }[];
  developerAnswer: string | null;
}
```

Then the two functions:

```typescript
export function buildSocraticPrompt(input: SocraticPromptInput): string {
  const { filePath, fileLanguage, recentContext, fileMemories, conversationHistory } = input;

  const lang = fileLanguage || "code";

  const recentBlock = recentContext
    .slice(0, 10)
    .map((e) => `- [${e.type}] ${e.summary} (concepts: ${e.concepts.join(", ")})`)
    .join("\n");

  const memoryBlock = fileMemories
    .slice(0, 5)
    .map((e) => `- ${e.summary}${e.error_verbatim ? ` | past error: ${e.error_verbatim}` : ""}${e.resolution ? ` | fix: ${e.resolution}` : ""}`)
    .join("\n");

  const historyBlock = conversationHistory.length > 0
    ? conversationHistory.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n")
    : "";

  return `You are Synaptic's Socratic tutor. A developer just opened ${filePath} (${lang}).

Your job: ask ONE targeted question that makes them articulate their intent before they write code. The question must be:
- Specific to this file and language (not generic)
- Grounded in what this developer actually knows from their history
- Probing a real decision point — types, architecture, error handling, performance — not trivia
- Short: one sentence, ending with a question mark
- Not a yes/no question

DEVELOPER'S RECENT ACTIVITY:
${recentBlock || "No recent activity."}

MEMORIES RELATED TO THIS FILE:
${memoryBlock || "No prior history for this file."}

${historyBlock ? `CONVERSATION SO FAR:\n${historyBlock}\n` : ""}
Output ONLY the question. No preamble, no explanation, no quotes.`;
}

export function buildSocraticEvalPrompt(input: SocraticPromptInput): string {
  const { filePath, fileLanguage, recentContext, fileMemories, conversationHistory, developerAnswer } = input;

  const lang = fileLanguage || "code";

  const recentBlock = recentContext
    .slice(0, 8)
    .map((e) => `- [${e.type}] ${e.summary} (concepts: ${e.concepts.join(", ")})`)
    .join("\n");

  const memoryBlock = fileMemories
    .slice(0, 4)
    .map((e) => `- ${e.summary}`)
    .join("\n");

  const historyBlock = conversationHistory
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n");

  return `You are Synaptic's Socratic evaluator. A developer is explaining their approach to ${filePath} (${lang}) before writing code.

DEVELOPER'S RECENT HISTORY:
${recentBlock || "No recent activity."}

FILE MEMORIES:
${memoryBlock || "No prior history for this file."}

CONVERSATION:
${historyBlock}

LATEST DEVELOPER ANSWER:
${developerAnswer}

Evaluate the explanation. Is it clear enough to suggest they understand what they're about to do?

Scoring guide:
- PASS: They named the specific approach, described at least one design decision, and mentioned a potential failure mode or edge case.
- FOLLOW-UP needed: They gave a vague answer ("I'll add some logic here"), skipped a key decision, or repeated the question back.
- FOLLOW-UP needed: They don't mention error handling, types, or edge cases at all for a non-trivial change.

Reply with JSON only:
{
  "passed": true or false,
  "feedback": "one sentence — either confirming what was good, or specifically what was missing",
  "followUp": "if passed=false, one specific follow-up question targeting the gap. If passed=true, omit this field."
}`;
}
```

---

## 7. Connector Change

### `src/connector/index.ts`

Import `SocraticEngine` at the top:

```typescript
import { SocraticEngine } from "../mentor/socratic-engine.js";
```

Add a `private socratic: SocraticEngine` field to the `Connector` class.

In the constructor, after `this.config = config`, add:

```typescript
this.socratic = new SocraticEngine(archivist, this.reasoner, config);
```

In the `start()` method, after the existing `eventBus.onCompressedEvent(...)` block, add:

```typescript
// Socratic gate — triggers on file_open for recognized code files
eventBus.onSocraticGate(async (gate) => {
  if (!this.config.socraticMode) return;
  console.log(`[Connector] Socratic gate triggered for ${gate.filePath}`);
  try {
    await this.socratic.startSession(gate);
  } catch (error) {
    console.error("[Connector] Socratic session start failed:", error);
  }
});
```

Add a public accessor so the server can reach the engine:

```typescript
getSocraticEngine(): SocraticEngine { return this.socratic; }
```

---

## 8. Server Changes

### `src/server.ts`

**Import addition** at the top:

```typescript
import type { SocraticQuestionEvent, SocraticResultEvent } from "./shared/types.js";
```

**New API endpoints** — add these three endpoints after the `/api/map-concept` endpoint block:

```typescript
// --- Socratic endpoints ---

app.post("/api/socratic/respond", async (req, res) => {
  const { sessionId, answer } = req.body as { sessionId?: string; answer?: string };
  if (!sessionId || !answer) {
    res.status(400).json({ error: "Missing sessionId or answer" });
    return;
  }
  try {
    await connector.getSocraticEngine().respondToSession(sessionId, answer);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Server] Socratic respond failed:", err);
    res.status(500).json({ error: "Failed to process response" });
  }
});

app.post("/api/socratic/skip", (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) { res.status(400).json({ error: "Missing sessionId" }); return; }
  connector.getSocraticEngine().skipSession(sessionId);
  res.json({ ok: true });
});

app.get("/api/socratic/session/:id", (req, res) => {
  const session = connector.getSocraticEngine().getSession(req.params.id);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  res.json(session);
});
```

**WebSocket broadcasts** — in the EventBus subscription block near the bottom of `createServer()`, add after the existing `eventBus.onHabitMismatch(...)` block:

```typescript
eventBus.onSocraticQuestion((event: SocraticQuestionEvent) => {
  broadcast("socratic_question", event);
});

eventBus.onSocraticResult((event: SocraticResultEvent) => {
  broadcast("socratic_result", event);
});
```

---

## 9. HUD Changes

### `src/ui/public/hud.html`

Read the existing hud.html first to understand the structure. The HUD is an Electron overlay panel with an existing chat-style input and markdown renderer.

Add a Socratic panel that appears as an overlay within the HUD when a `socratic_question` WebSocket message arrives. It should disappear when `socratic_result` arrives with `passed: true`, or when the user clicks Skip (if strictness is `followup`).

**State variables to add to the JS section:**

```javascript
let socraticSession = null; // { sessionId, filePath, strictness }
```

**WebSocket message handler additions** — inside the existing `ws.onmessage` handler, add cases for the two new types:

```javascript
case 'socratic_question': {
  socraticSession = {
    sessionId: data.sessionId,
    filePath: data.filePath,
    isFollowUp: data.isFollowUp,
  };
  showSocraticPanel(data);
  break;
}
case 'socratic_result': {
  if (data.passed) {
    hideSocraticPanel(data.feedback);
  } else {
    // show feedback inline in the panel
    showSocraticFeedback(data.feedback);
  }
  break;
}
```

**New functions to add:**

```javascript
function showSocraticPanel(data) {
  const panel = document.getElementById('socratic-panel');
  const questionEl = document.getElementById('socratic-question');
  const fileEl = document.getElementById('socratic-file');
  const labelEl = document.getElementById('socratic-label');
  
  fileEl.textContent = data.filePath.split('/').pop(); // just the filename
  labelEl.textContent = data.isFollowUp ? 'Follow-up question:' : 'Before you code:';
  questionEl.textContent = data.question;
  
  document.getElementById('socratic-input').value = '';
  document.getElementById('socratic-feedback').textContent = '';
  panel.style.display = 'flex';
  document.getElementById('socratic-input').focus();
}

function hideSocraticPanel(successMessage) {
  const panel = document.getElementById('socratic-panel');
  if (successMessage) {
    document.getElementById('socratic-feedback').textContent = '✓ ' + successMessage;
    document.getElementById('socratic-feedback').style.color = '#4caf50';
    setTimeout(() => { panel.style.display = 'none'; }, 1800);
  } else {
    panel.style.display = 'none';
  }
  socraticSession = null;
}

function showSocraticFeedback(feedback) {
  const el = document.getElementById('socratic-feedback');
  el.textContent = feedback;
  el.style.color = '#f0c040';
}

async function submitSocraticAnswer() {
  if (!socraticSession) return;
  const answer = document.getElementById('socratic-input').value.trim();
  if (!answer) return;
  
  document.getElementById('socratic-submit').disabled = true;
  document.getElementById('socratic-feedback').textContent = 'Evaluating...';
  document.getElementById('socratic-feedback').style.color = '#888';
  
  try {
    await fetch('/api/socratic/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: socraticSession.sessionId, answer }),
    });
    // Result comes back via WebSocket — don't handle here
  } catch (e) {
    document.getElementById('socratic-feedback').textContent = 'Error — try again';
  } finally {
    document.getElementById('socratic-submit').disabled = false;
  }
}

async function skipSocratic() {
  if (!socraticSession) return;
  await fetch('/api/socratic/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: socraticSession.sessionId }),
  });
  hideSocraticPanel(null);
}
```

**HTML panel to inject** — place this as the first child of the `<body>`, before the existing main container. Style it to appear as a card overlaying the bottom portion of the HUD:

```html
<div id="socratic-panel" style="display:none; position:fixed; bottom:0; left:0; right:0;
  background:#12121e; border-top:2px solid #f0c040; padding:14px 16px; flex-direction:column;
  gap:10px; z-index:1000; font-family:inherit;">
  
  <div style="display:flex; justify-content:space-between; align-items:center;">
    <span id="socratic-label" style="color:#f0c040; font-size:11px; font-weight:600;
      text-transform:uppercase; letter-spacing:0.06em;">Before you code:</span>
    <span id="socratic-file" style="color:#888; font-size:11px;"></span>
  </div>

  <div id="socratic-question" style="color:#e8e8e8; font-size:14px; line-height:1.5;
    padding:10px 12px; background:#1a1a2e; border-radius:6px; border-left:3px solid #f0c040;">
  </div>

  <textarea id="socratic-input" rows="3" placeholder="Type your explanation..."
    style="width:100%; background:#1a1a2e; color:#e8e8e8; border:1px solid #333;
    border-radius:6px; padding:10px; font-size:13px; resize:none; font-family:inherit;
    box-sizing:border-box;"
    onkeydown="if(event.key==='Enter' && (event.metaKey||event.ctrlKey)) submitSocraticAnswer()">
  </textarea>

  <div style="display:flex; gap:8px; align-items:center;">
    <button id="socratic-submit" onclick="submitSocraticAnswer()"
      style="background:#f0c040; color:#0a0a14; border:none; padding:8px 18px;
      border-radius:5px; font-weight:600; cursor:pointer; font-size:13px;">
      Submit
    </button>
    <button onclick="skipSocratic()"
      style="background:transparent; color:#666; border:1px solid #333; padding:8px 14px;
      border-radius:5px; cursor:pointer; font-size:13px;">
      Skip
    </button>
    <span id="socratic-feedback" style="font-size:12px; color:#888; flex:1; text-align:right;"></span>
  </div>
</div>
```

**Keyboard shortcut** — the existing voice input uses `Cmd+Shift+V`. Bind `Enter` with `Cmd` or `Ctrl` to submit the Socratic answer (already included in the `onkeydown` above). No new global shortcuts needed.

---

## 10. Dashboard Change (Optional but Recommended)

### `src/ui/public/index.html`

Read the existing file first. In the activity timeline or stats section, add a small indicator that shows when a Socratic session is active. When a `socratic_question` WebSocket message arrives, display a dismissible banner:

```
⚡ Socratic session active — answer in the HUD before coding [filename.ts]
```

When `socratic_result` arrives with `passed: true`, replace the banner with:

```
✓ Explanation accepted for [filename.ts]
```

Auto-dismiss the success banner after 3 seconds.

---

## 11. README Update

### `README.md`

Add a new section under **Features**, after "Habit mismatch detection":

```markdown
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
```

Also add to the **API reference → Query endpoints** table:

| `POST` | `/api/socratic/respond` | `{ sessionId, answer }` | Submit an explanation to an active Socratic session |
| `POST` | `/api/socratic/skip` | `{ sessionId }` | Skip the current Socratic session |
| `GET` | `/api/socratic/session/:id` | — | Get full session history including Q&A turns |

---

## 12. File Summary (what to create vs. modify)

| File | Action |
|---|---|
| `src/mentor/socratic-engine.ts` | **CREATE** — full file above |
| `src/shared/types.ts` | **MODIFY** — add 5 new interfaces + 2 config fields |
| `src/shared/event-bus.ts` | **MODIFY** — add 6 new methods |
| `src/connector/prompts.ts` | **MODIFY** — add 2 new exported functions |
| `src/connector/index.ts` | **MODIFY** — import + field + start() handler + accessor |
| `src/observer/file-watcher.ts` | **MODIFY** — emit socratic_gate after file_open |
| `src/server.ts` | **MODIFY** — 3 new endpoints + 2 new WebSocket listeners |
| `src/ui/public/hud.html` | **MODIFY** — panel HTML + 5 new JS functions + WS handlers |
| `src/ui/public/index.html` | **MODIFY** — banner for active session (optional) |
| `synaptic.config.example.json` | **MODIFY** — 2 new fields (already done above, verify) |
| `README.md` | **MODIFY** — new feature section + API table rows |

---

## 13. Testing the Feature

After implementation, test this sequence manually:

1. Start Synaptic: `npm run dev`
2. Enable socratic mode: `curl -X POST http://localhost:3777/api/config -H "Content-Type: application/json" -d '{"socraticMode":true,"socraticStrictness":"followup"}'`
3. Open the HUD: `Cmd+Shift+S`
4. Open any `.ts` or `.py` file in a watched directory
5. The HUD panel should appear within ~3 seconds with a question about the file
6. Type an explanation and press `Cmd+Enter` — the panel should show "Evaluating..."
7. A follow-up or success message should appear via WebSocket within ~5 seconds
8. Check the console for `[Socratic] Session ... closed` log

---

## 14. Known Edge Cases

**Debouncing**: If the developer opens and closes a file quickly, multiple sessions may start. Add a debounce of 2000ms on the `emitSocraticGate` call in file-watcher — only emit if the file remains open for 2 seconds. Use `setTimeout` and store the timeout per filePath, clearing it if another event arrives for the same path.

**Model latency**: Gemma 27B takes 3–8 seconds locally. The HUD panel should not appear instantly but should appear with the question already filled in (don't show an empty panel with a loading spinner — that's confusing). The `startSession()` call resolves with the question before `emitSocraticQuestion()` fires, so this is already handled correctly by the spec above.

**Same file reopened**: If a `socratic_gate` fires for a file that already has an open session (status = "open"), skip creating a new session. Check the in-memory `sessions` Map for any session with matching `filePath` and status `"open"` before calling `startSession()`.

**config.socraticMode = false**: The FileWatcher checks `config.socraticMode` before emitting the gate. The Connector's `onSocraticGate` handler also checks it. Either guard is sufficient — both are there for defense in depth.
