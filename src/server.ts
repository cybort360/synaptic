import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { execSync, execFile } from "child_process";
import { tmpdir, homedir } from "os";
import path from "path";
import type { Server } from "http";
import type { Connector } from "./connector/index.js";
import type { Archivist } from "./archivist/index.js";
import type { Observer } from "./observer/index.js";
import type { SynapticConfig, SocraticQuestionEvent, SocraticResultEvent } from "./shared/types.js";
import { eventBus } from "./shared/event-bus.js";
import { BridgeEngine } from "./mentor/bridge-engine.js";

let paused = false;
let habitMismatches = 0;

function findWhisperBin(): string {
  try {
    const cmd = process.platform === "win32" ? "where whisper" : "which whisper";
    return execSync(cmd, { encoding: "utf-8" }).trim().split("\n")[0];
  } catch {}
  if (process.platform === "darwin") {
    for (const ver of ["3.13", "3.12", "3.11", "3.10", "3.9"]) {
      const p = path.join(homedir(), `Library/Python/${ver}/bin/whisper`);
      if (existsSync(p)) return p;
    }
  }
  // Linux / pip install --user
  const local = path.join(homedir(), ".local/bin/whisper");
  if (existsSync(local)) return local;
  return "whisper"; // will surface a clear "not found" error
}

export function createServer(connector: Connector, archivist: Archivist, config: SynapticConfig, observer: Observer): Server {
  const app = express();
  const bridge = new BridgeEngine(archivist, connector.getReasoner(), config);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.static("src/ui/public"));
  app.get("/hud", (_req, res) => res.sendFile("hud.html", { root: "src/ui/public" }));

  // Shared SSE setup — flushes headers immediately so the browser gets 200 OK
  // before the first token. Without this, Express buffers headers until the
  // first res.write(), causing a blank hang while waiting on Ollama.
  function startSSE(res: import("express").Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(": connected\n\n"); // forces headers + TCP flush immediately
    return (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // --- Query endpoints ---

  app.post("/api/query", async (req, res) => {
    const { question, imageBase64 } = req.body as { question?: string; imageBase64?: string };
    if (!question) { res.status(400).json({ error: "Missing 'question' field" }); return; }
    const send = startSSE(res);
    try {
      for await (const token of connector.queryStream(question, imageBase64)) send({ token });
      send({ done: true });
    } catch { send({ error: "Query failed" }); }
    res.end();
  });

  app.post("/api/bridge", async (req, res) => {
    const { error, lang, concepts, imageBase64 } = req.body as {
      error?: string; lang?: string; concepts?: string[]; imageBase64?: string;
    };
    if (!error) { res.status(400).json({ error: "Missing 'error' field" }); return; }
    const send = startSSE(res);
    const targetLang = lang || config.toLang || "the target language";
    try {
      const stream = await bridge.explain(error, targetLang, concepts ?? [], imageBase64);
      for await (const token of stream) send({ token });
      send({ done: true });
    } catch { send({ error: "Bridge failed" }); }
    res.end();
  });

  app.post("/api/voice", async (req, res) => {
    const { audio, mimeType = "audio/webm" } = req.body as { audio?: string; mimeType?: string };
    if (!audio) { res.status(400).json({ error: "Missing audio" }); return; }

    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    const tmpAudio = path.join(tmpdir(), `synaptic-voice-${Date.now()}.${ext}`);
    const tmpWav   = tmpAudio.replace(`.${ext}`, ".wav");

    try {
      writeFileSync(tmpAudio, Buffer.from(audio, "base64"));

      // Convert to WAV (whisper needs PCM)
      await new Promise<void>((resolve, reject) => {
        execFile("ffmpeg", ["-y", "-i", tmpAudio, "-ar", "16000", "-ac", "1", tmpWav],
          (err) => err ? reject(err) : resolve()
        );
      });

      const whisperBin = findWhisperBin();
      const result = execSync(
        `"${whisperBin}" "${tmpWav}" --model tiny --output_format txt --output_dir "${tmpdir()}" --fp16 False`,
        { encoding: "utf-8", timeout: 120000 }
      );

      const txtFile = tmpWav.replace(".wav", ".txt");
      const transcript = existsSync(txtFile)
        ? execSync(`cat "${txtFile}"`, { encoding: "utf-8" }).trim()
        : result.trim();

      res.json({ transcript });
    } catch (err) {
      console.error("[Voice] Transcription failed:", err);
      res.status(500).json({ error: "Transcription failed — is whisper installed? pip install openai-whisper" });
    } finally {
      [tmpAudio, tmpWav, tmpWav.replace(".wav", ".txt")].forEach(f => { try { unlinkSync(f) } catch {} });
    }
  });

  app.post("/api/explain", async (req, res) => {
    const { question } = req.body as { question?: string };
    if (!question) { res.status(400).json({ error: "Missing 'question'" }); return; }
    const send = startSSE(res);
    try {
      for await (const token of connector.explainStream(question)) send({ token });
      send({ done: true });
    } catch { send({ error: "Explain failed" }); }
    res.end();
  });

  app.post("/api/translate", async (req, res) => {
    const { question, fromLang, toLang } = req.body as { question?: string; fromLang?: string; toLang?: string };
    if (!question) { res.status(400).json({ error: "Missing 'question'" }); return; }
    const send = startSSE(res);
    try {
      for await (const token of connector.translateStream(question, fromLang, toLang)) send({ token });
      send({ done: true });
    } catch { send({ error: "Translation failed" }); }
    res.end();
  });

  app.post("/api/map-concept", async (req, res) => {
    const { concept } = req.body as { concept?: string };
    if (!concept) { res.status(400).json({ error: "Missing 'concept'" }); return; }
    const send = startSSE(res);
    try {
      for await (const token of connector.mapConceptStream(concept)) send({ token });
      send({ done: true });
    } catch { send({ error: "Concept mapping failed" }); }
    res.end();
  });

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
    if (config.socraticStrictness === "gate") {
      res.status(403).json({ error: "Skip not allowed in gate mode" });
      return;
    }
    connector.getSocraticEngine().skipSession(sessionId);
    res.json({ ok: true });
  });

  app.get("/api/socratic/session/:id", (req, res) => {
    const session = connector.getSocraticEngine().getSession(req.params.id);
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    res.json(session);
  });

  // --- Event/data endpoints ---

  app.get("/api/events/recent", (req, res) => {
    const hours = Number(req.query.hours) || 2;
    res.json(archivist.getActiveContext(hours));
  });

  app.get("/api/events/significant", (req, res) => {
    const min = Number(req.query.min) || 0.7;
    const limit = Number(req.query.limit) || 100;
    res.json(archivist.getHighSignificanceEvents(min, limit));
  });

  app.get("/api/events/project/:name", (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json(archivist.getEventsByProject(req.params.name, limit));
  });

  app.get("/api/events/concept/:concept", (req, res) => {
    const limit = Number(req.query.limit) || 20;
    res.json(archivist.searchByConcept(req.params.concept, limit));
  });

  app.get("/api/events/:id/connections", (req, res) => {
    res.json(archivist.getConnectionsForEvent(req.params.id));
  });

  // --- Debug endpoints ---

  app.get("/api/debug", async (req, res) => {
    const ollama = new (await import("./shared/ollama-client.js")).OllamaClient(config.ollamaBaseUrl);
    const ollamaRunning = await ollama.isRunning();
    const pulledModels = ollamaRunning ? await ollama.listModels() : [];
    const stats = archivist.getDB().getStats();
    res.json({
      ollamaRunning,
      pulledModels,
      neededModels: {
        compression: config.ollamaModel,
        vision: config.visionModel,
        reasoning: config.ollamaReasoningModel,
        embedding: config.embeddingModel,
      },
      missingModels: ollamaRunning ? [
        config.ollamaModel,
        config.ollamaReasoningModel,
        config.embeddingModel,
      ].filter(m => !pulledModels.some(p => p.startsWith(m.split(":")[0]))) : "ollama not reachable",
      watchPaths: config.watchPaths,
      eventQueueLength: archivist.getQueueLength(),
      processingBatch: archivist.isProcessing(),
      totalEventsInDB: stats.totalEvents,
    });
  });

  app.post("/api/debug/test-event", (req, res) => {
    const watchRoot = config.watchPaths[0] || process.cwd();
    const projectName = watchRoot.split("/").pop() || "project";
    eventBus.emitRawEvent({
      timestamp: new Date().toISOString(),
      type: "file_save",
      source: "file_watcher",
      data: {
        filePath: `${watchRoot}/test-file.ts`,
        fileName: "test-file.ts",
        extension: ".ts",
        project: projectName,
        content: "// test event fired from dashboard",
      },
    });
    res.json({ ok: true, message: "Test event queued — check activity tab in ~5 seconds" });
  });

  app.delete("/api/events", (req, res) => {
    const olderThanDays = req.query.olderThanDays ? Number(req.query.olderThanDays) : undefined;
    archivist.getDB().clearEvents(olderThanDays);
    res.json({ ok: true });
  });

  app.get("/api/errors/unresolved", (req, res) => {
    res.json(archivist.getDB().getUnresolvedErrors());
  });

  app.get("/api/stats", (req, res) => {
    res.json({ ...archivist.getDB().getStats(), habitMismatches, paused });
  });

  app.get("/api/projects", (req, res) => {
    res.json(archivist.getDB().getProjectStats());
  });

  // --- Config endpoints ---

  app.get("/api/config", (req, res) => {
    const safe = { ...config, reasoningModelApiKey: config.reasoningModelApiKey ? "***" : "" };
    res.json(safe);
  });

  app.post("/api/config", (req, res) => {
    const update = req.body as Partial<SynapticConfig>;
    if (update.watchPaths) observer.addWatchPaths(update.watchPaths);
    Object.assign(config, update);
    if (update.watchers) Object.assign(config.watchers, update.watchers);
    try {
      writeFileSync("synaptic.config.json", JSON.stringify(config, null, 2));
      broadcast("config_changed", config);
      res.json({ ok: true, config });
    } catch {
      res.status(500).json({ error: "Failed to save config" });
    }
  });

  // --- Native directory picker (macOS) ---

  app.post("/api/browse-directory", (req, res) => {
    if (process.platform !== "darwin") {
      res.status(400).json({ error: "Native folder picker is macOS-only — enter the path manually" });
      return;
    }
    try {
      const picked = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select a directory to watch:")'`,
        { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      res.json({ path: picked });
    } catch {
      res.status(400).json({ error: "No directory selected" });
    }
  });

  // --- Observer control ---

  app.post("/api/pause", (req, res) => {
    paused = true;
    eventBus.emitObserverStatus({ watchers: { files: "paused", terminal: "paused", windows: "paused", shellHistory: "paused" } });
    res.json({ ok: true, paused: true });
  });

  app.post("/api/resume", (req, res) => {
    paused = false;
    eventBus.emitObserverStatus({ watchers: { files: "active", terminal: "active", windows: "active", shellHistory: "active" } });
    res.json({ ok: true, paused: false });
  });

  // --- HTTP server ---

  const server = app.listen(config.port, () => {
    console.log(`[Server] Running on http://localhost:${config.port}`);
  });

  // --- WebSocket ---

  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();

  const broadcast = (type: string, data: unknown) => {
    const message = JSON.stringify({ type, data });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  wss.on("connection", (ws) => {
    clients.add(ws);
    // Send current state on connect
    ws.send(JSON.stringify({ type: "stats", data: { ...archivist.getDB().getStats(), habitMismatches, paused } }));
    ws.send(JSON.stringify({ type: "observer_status", data: { watchers: { files: "active", terminal: "active", windows: "active", shellHistory: "active" } } }));
    ws.on("close", () => clients.delete(ws));
  });

  eventBus.onCompressedEvent((event) => {
    if (!paused) broadcast("new_event", event);
  });

  eventBus.onQueryResult((result) => {
    broadcast("query_result", result);
  });

  eventBus.onStuckDetected((context) => {
    broadcast("stuck_detected", context);
  });

  eventBus.onHabitMismatch((mismatch) => {
    habitMismatches++;
    broadcast("habit_mismatch", mismatch);
    broadcast("stats", { ...archivist.getDB().getStats(), habitMismatches, paused });
  });

  eventBus.onSocraticQuestion((event: SocraticQuestionEvent) => {
    broadcast("socratic_question", event);
  });

  eventBus.onSocraticResult((event: SocraticResultEvent) => {
    broadcast("socratic_result", event);
  });

  eventBus.onObserverStatus((status) => {
    broadcast("observer_status", status);
  });

  return server;
}
