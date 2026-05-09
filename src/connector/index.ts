import { Reasoner } from "./reasoner.js";
import {
  buildConnectionPrompt,
  buildStuckAssistancePrompt,
  buildMentalMapPrompt,
  buildTranslatePrompt,
  buildHabitMismatchPrompt,
} from "./prompts.js";
import { eventBus } from "../shared/event-bus.js";
import type { Archivist } from "../archivist/index.js";
import type { SynapticConfig, QueryResult, HabitMismatch } from "../shared/types.js";

// Language → file extensions. Add any language here — no code changes needed elsewhere.
export const LANG_EXTENSIONS: Record<string, string[]> = {
  javascript:  [".js", ".jsx", ".mjs", ".cjs"],
  typescript:  [".ts", ".tsx"],
  python:      [".py", ".pyw"],
  rust:        [".rs"],
  go:          [".go"],
  ruby:        [".rb", ".rake"],
  java:        [".java"],
  kotlin:      [".kt", ".kts"],
  swift:       [".swift"],
  "c#":        [".cs"],
  "c++":       [".cpp", ".cc", ".cxx", ".hpp"],
  c:           [".c", ".h"],
  php:         [".php"],
  elixir:      [".ex", ".exs"],
  dart:        [".dart"],
  scala:       [".scala"],
  zig:         [".zig"],
  lua:         [".lua"],
  haskell:     [".hs"],
};

export function extensionsForLang(lang: string): string[] {
  return LANG_EXTENSIONS[lang.toLowerCase()] ?? [];
}

export class Connector {
  private reasoner: Reasoner;
  private archivist: Archivist;
  private config: SynapticConfig;
  private habitCheckQueue: string[] = [];
  private habitCheckInterval: NodeJS.Timeout | null = null;

  constructor(config: SynapticConfig, archivist: Archivist) {
    this.reasoner = new Reasoner(config);
    this.archivist = archivist;
    this.config = config;
  }

  start() {
    eventBus.onStuckDetected(async (context) => {
      console.log("[Connector] Stuck detected, gathering context...");
      try {
        const result = await this.handleStuckDetection(context);
        eventBus.emitQueryResult(result);
      } catch (error) {
        console.error("[Connector] Failed to handle stuck detection:", error);
      }
    });

    // Watch compressed events for habit mismatches in toLang files
    eventBus.onCompressedEvent((event) => {
      const exts = extensionsForLang(this.config.toLang);
      if (exts.length && event.file && exts.some((ext) => event.file!.endsWith(ext))) {
        this.habitCheckQueue.push(event.summary + (event.error_verbatim ? " | " + event.error_verbatim : ""));
      }
    });

    // Run habit mismatch check every 15 seconds
    this.habitCheckInterval = setInterval(() => this.runHabitCheck(), 15_000);

    console.log("[Connector] Ready for queries and stuck detection");
  }

  async query(question: string): Promise<QueryResult> {
    const lang = this.langCtx();
    const currentContext = this.archivist.getActiveContext(2);
    const retrievedMemories = this.archivist.semanticSearch(question, 15);
    const prompt = buildConnectionPrompt(currentContext, retrievedMemories, question, lang);
    const insight = await this.reasoner.reason(prompt);
    return {
      query: question,
      mode: "find_solution",
      relevant_events: retrievedMemories,
      connections: [],
      insight,
      grounded_in: retrievedMemories.length,
    };
  }

  async *queryStream(question: string, imageBase64?: string): AsyncGenerator<string> {
    const lang = this.langCtx();
    const currentContext = this.archivist.getActiveContext(2);
    const retrievedMemories = this.archivist.semanticSearch(question, 15);
    const prompt = buildConnectionPrompt(currentContext, retrievedMemories, question, lang);
    yield* this.reasoner.reasonStream(prompt, imageBase64);
  }

  async translate(question: string, fromLang?: string, toLang?: string): Promise<QueryResult> {
    const from = fromLang || this.config.fromLang || undefined;
    const to   = toLang   || this.config.toLang   || undefined;
    const retrievedMemories = this.archivist.semanticSearch(question, 10);
    const prompt = buildTranslatePrompt(question, from, to, retrievedMemories);
    const insight = await this.reasoner.reason(prompt);
    const langPart = to ? to.toUpperCase() : "TARGET";
    const conceptPart = this.extractConcept(question);
    return {
      query: question,
      mode: "translate",
      relevant_events: retrievedMemories,
      connections: [],
      insight,
      grounded_in: retrievedMemories.length,
      breadcrumb: ["QUERY", conceptPart, langPart],
    };
  }

  async mapConcept(newConcept: string): Promise<QueryResult> {
    const lang = this.langCtx();
    const recentEvents = this.archivist.getActiveContext(48);
    const knownConcepts = [...new Set(recentEvents.flatMap((e) => e.concepts))];
    const prompt = buildMentalMapPrompt(newConcept, knownConcepts, lang);
    const insight = await this.reasoner.reason(prompt);
    return {
      query: `Map concept: ${newConcept}`,
      mode: "map_concept",
      relevant_events: [],
      connections: [],
      insight,
      grounded_in: knownConcepts.length,
    };
  }

  private langCtx(): { from: string; to: string } | null {
    const { fromLang, toLang } = this.config;
    return fromLang && toLang ? { from: fromLang, to: toLang } : null;
  }

  getReasoner(): Reasoner { return this.reasoner; }

  stop() {
    if (this.habitCheckInterval) {
      clearInterval(this.habitCheckInterval);
      this.habitCheckInterval = null;
    }
  }

  private async runHabitCheck() {
    if (this.habitCheckQueue.length === 0) return;
    const { fromLang, toLang } = this.config;
    if (!fromLang || !toLang) return;

    const batch = this.habitCheckQueue.splice(0).join("\n");
    const recentEvents = this.archivist.getActiveContext(1);
    const knownPatterns = recentEvents.map((e) => e.summary);
    const prompt = buildHabitMismatchPrompt(batch, fromLang, toLang, knownPatterns);

    try {
      const raw = await this.reasoner.reason(prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const result = JSON.parse(jsonMatch[0]) as { found: boolean } & HabitMismatch;
      if (result.found) {
        eventBus.emitHabitMismatch({
          pattern: result.pattern,
          oldLang: result.oldLang,
          newLang: result.newLang,
          warning: result.warning,
          trapType: result.trapType,
        });
      }
    } catch {
      // silent — no fallback needed, model handles all language pairs
    }
  }

  private extractConcept(question: string): string {
    const words = question.split(/\s+/).filter((w) => w.length > 4);
    return (words[0] || "CONCEPT").toUpperCase().slice(0, 20);
  }

  private async handleStuckDetection(context: {
    file: string | null;
    duration: number;
    signals: string[];
  }): Promise<QueryResult> {
    const stuckQuery = [context.file ? `Working on: ${context.file}` : "", ...context.signals]
      .filter(Boolean)
      .join(". ");

    const currentContext = this.archivist.getActiveContext(1);
    const retrievedMemories = this.archivist.semanticSearch(stuckQuery, 10);
    const prompt = buildStuckAssistancePrompt(currentContext, retrievedMemories, context.signals);
    const insight = await this.reasoner.reason(prompt);

    return {
      query: `[Auto-detected] Stuck for ${context.duration} min`,
      relevant_events: retrievedMemories,
      connections: [],
      insight,
      grounded_in: retrievedMemories.length,
    };
  }
}

export { Reasoner };
