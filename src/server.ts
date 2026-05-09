import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { execSync, execFile } from "child_process";
import { tmpdir, homedir } from "os";
import path from "path";
import type { Server } from "http";
import type { Connector } from "./connector/index.js";
import type { Archivist } from "./archivist/index.js";
import type { SynapticConfig } from "./shared/types.js";
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

export function createServer(connector: Connector, archivist: Archivist, config: SynapticConfig): Server {
  const app = express();
  const bridge = new BridgeEngine(archivist, connector.getReasoner(), config);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.static("src/ui/public"));
  app.get("/hud", (_req, res) => res.sendFile("hud.html", { root: "src/ui/public" }));

  // --- Query endpoints ---

  app.post("/api/query", async (req, res) => {
    const { question, imageBase64 } = req.body as { question?: string; imageBase64?: string };
    if (!question) { res.status(400).json({ error: "Missing 'question' field" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      for await (const token of connector.queryStream(question, imageBase64)) {
        send({ token });
      }
      send({ done: true });
    } catch (err) {
      send({ error: "Query failed" });
    }
    res.end();
  });

  app.post("/api/bridge", async (req, res) => {
    const { error, lang, concepts, imageBase64 } = req.body as {
      error?: string; lang?: string; concepts?: string[]; imageBase64?: string;
    };
    if (!error) { res.status(400).json({ error: "Missing 'error' field" }); return; }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const targetLang = lang || config.toLang || "the target language";

    try {
      const stream = await bridge.explain(error, targetLang, concepts ?? [], imageBase64);
      for await (const token of stream) send({ token });
      send({ done: true });
    } catch (err) {
      send({ error: "Bridge failed" });
    }
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

  app.post("/api/translate", async (req, res) => {
    const { question, fromLang, toLang } = req.body as { question?: string; fromLang?: string; toLang?: string };
    if (!question) { res.status(400).json({ error: "Missing 'question'" }); return; }
    try { res.json(await connector.translate(question, fromLang, toLang)); }
    catch { res.status(500).json({ error: "Translation failed" }); }
  });

  app.post("/api/map-concept", async (req, res) => {
    const { concept } = req.body as { concept?: string };
    if (!concept) { res.status(400).json({ error: "Missing 'concept'" }); return; }
    try { res.json(await connector.mapConcept(concept)); }
    catch { res.status(500).json({ error: "Concept mapping failed" }); }
  });

  // --- Event/data endpoints ---

  app.get("/api/events/recent", (req, res) => {
    const hours = Number(req.query.hours) || 2;
    res.json(archivist.getActiveContext(hours));
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
    res.json(config);
  });

  app.post("/api/config", (req, res) => {
    const update = req.body as Partial<SynapticConfig>;
    Object.assign(config, update);
    if (update.watchers) Object.assign(config.watchers, update.watchers);
    try {
      writeFileSync("synaptic.config.json", JSON.stringify(config, null, 2));
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
    broadcast("observer_status", { watchers: { files: "paused", terminal: "paused", windows: "paused", shellHistory: "paused" } });
    res.json({ ok: true, paused: true });
  });

  app.post("/api/resume", (req, res) => {
    paused = false;
    broadcast("observer_status", { watchers: { files: "active", terminal: "active", windows: "active", shellHistory: "active" } });
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

  return server;
}
