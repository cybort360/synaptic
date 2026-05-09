import { SynapticDB } from "./db.js";
import { Compressor } from "./compressor.js";
import { Embedder } from "./embeddings.js";
import { eventBus } from "../shared/event-bus.js";
import type { RawEvent, CompressedEvent, SynapticConfig } from "../shared/types.js";

/**
 * The Archivist module: receives raw events from the Observer,
 * compresses them via the local Gemma 4 E4B model,
 * generates embeddings, and stores everything in SQLite.
 */
const CONCEPT_WINDOW = 10; // how many past events to consider "known" concepts

export class Archivist {
  private db: SynapticDB;
  private compressor: Compressor;
  private embedder: Embedder;
  private eventQueue: RawEvent[] = [];
  private processing = false;
  private batchInterval: NodeJS.Timeout | null = null;
  private recentConceptHistory: string[][] = [];

  constructor(config: SynapticConfig) {
    this.db = new SynapticDB(config.dbPath);
    this.compressor = new Compressor(config.ollamaBaseUrl, config.ollamaModel);
    this.embedder = new Embedder();
  }

  async init() {
    await this.db.init();
  }

  start() {
    // Listen for raw events from the Observer
    eventBus.onRawEvent((event) => {
      console.log(`[Archivist] Queued: ${event.type} → ${event.data.filePath || event.data.command || event.data.app || "?"}`);
      this.eventQueue.push(event);
    });

    // Process events in batches every 3 seconds
    this.batchInterval = setInterval(() => {
      this.processBatch();
    }, 3000);

    console.log("[Archivist] Ready to receive and compress events");
  }

  private async processBatch() {
    if (this.processing || this.eventQueue.length === 0) return;
    this.processing = true;

    // Take up to 5 events at a time
    const batch = this.eventQueue.splice(0, 5);

    for (const rawEvent of batch) {
      try {
        console.log(`[Archivist] Compressing: ${rawEvent.type}...`);
        const screenshot = rawEvent.data.screenshot as string | undefined;
        const compressed = screenshot
          ? await this.compressor.compressWithVision(rawEvent, screenshot)
          : await this.compressor.compress(rawEvent);

        console.log(`[Archivist] Compressed: significance=${compressed.significance.toFixed(2)} concepts=[${compressed.concepts.join(", ")}]`);

        if (!this.isConceptEvolution(compressed)) {
          console.log(`[Archivist] Skipped (low significance / known concepts)`);
          this.trackConcepts(compressed.concepts);
          continue;
        }

        const textForEmbedding = [
          compressed.summary,
          ...compressed.concepts,
          compressed.file || "",
          compressed.error_verbatim || "",
        ].join(" ");

        compressed.embedding = this.embedder.embed(textForEmbedding);

        this.db.insertEvent(compressed);
        this.trackConcepts(compressed.concepts);
        eventBus.emitCompressedEvent(compressed);
        console.log(`[Archivist] Stored: "${compressed.summary.slice(0, 80)}..."`);
      } catch (error) {
        console.error("[Archivist] Failed to process event:", error);
      }
    }

    this.processing = false;
  }

  private isConceptEvolution(compressed: CompressedEvent): boolean {
    // Always persist errors and high-significance events
    if (compressed.significance >= 0.7) return true;
    if (compressed.error_verbatim) return true;

    // Persist if any concept hasn't been seen in the recent window
    const known = new Set(this.recentConceptHistory.flat());
    return compressed.concepts.some((c) => !known.has(c));
  }

  private trackConcepts(concepts: string[]) {
    this.recentConceptHistory.push(concepts);
    if (this.recentConceptHistory.length > CONCEPT_WINDOW) {
      this.recentConceptHistory.shift();
    }
  }

  /**
   * Retrieve events semantically similar to a query string.
   */
  semanticSearch(query: string, topK = 10): CompressedEvent[] {
    const queryEmbedding = this.embedder.embed(query);
    const allEvents = this.db.getAllEventsWithEmbeddings();

    const candidates = allEvents
      .filter((e) => e.embedding !== null)
      .map((e) => ({ id: e.id, embedding: e.embedding! }));

    const results = this.embedder.findSimilar(queryEmbedding, candidates, topK);
    const resultIds = new Set(results.map((r) => r.id));

    return allEvents.filter((e) => resultIds.has(e.id));
  }

  /**
   * Get the current active context (recent uncompressed events + recent DB events).
   */
  getActiveContext(hours = 2): CompressedEvent[] {
    return this.db.getRecentEvents(hours);
  }

  getDB(): SynapticDB {
    return this.db;
  }

  getEmbedder(): Embedder {
    return this.embedder;
  }

  stop() {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    this.db.close();
    console.log("[Archivist] Stopped");
  }
}

export { SynapticDB, Compressor, Embedder };
