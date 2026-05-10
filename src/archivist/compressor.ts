import type { RawEvent, CompressedEvent } from "../shared/types.js";
import { OllamaClient } from "../shared/ollama-client.js";
import { randomUUID } from "crypto";

const VISION_ERROR_PROMPT = `You are analyzing a screenshot of a developer's terminal that contains an error. Extract the key information visible on screen.

Reply with JSON only:
{
  "error_verbatim": "the exact, complete error message text visible on screen",
  "file": "filepath:line if visible in the error, otherwise null",
  "command": "the command or action that triggered this error if visible",
  "context": "one sentence describing what the developer was doing when this happened"
}

If the screenshot does not clearly show a terminal error, reply: { "error_verbatim": null, "file": null, "command": null, "context": null }`;

const COMPRESSION_PROMPT = `You are a cognitive event compressor for a developer assistant. Given a raw development event, identify whether it represents a meaningful shift in the developer's understanding or approach — a "concept evolution."

Significance scoring:
- 0.9+: New error root cause, concept breakthrough, approach change (e.g. switched from callbacks to async/await)
- 0.7-0.89: Error resolution, new API or pattern introduced, significant refactor
- 0.4-0.69: Continued work on an established pattern, incremental progress
- <0.4: Routine edit with no conceptual shift

Rules:
1. Preserve EXACT file paths, line numbers, and error messages verbatim
2. The "concepts" array must name the specific programming concepts at play (e.g. "borrow-checker", "async-runtime", "ownership", "tokio::join!")
3. Focus the summary on WHAT CHANGED conceptually, not just what happened mechanically

Output ONLY valid JSON:
{
  "summary": "string - one dense sentence on the conceptual shift",
  "concepts": ["specific programming concepts involved"],
  "significance": 0.0-1.0,
  "error_verbatim": "string or null - exact error text if applicable",
  "resolution": "string or null - how the concept was resolved"
}`;

export class Compressor {
  private ollama: OllamaClient;
  private model: string;
  private visionModel: string;

  constructor(ollamaBaseUrl: string, model: string, visionModel?: string) {
    this.ollama = new OllamaClient(ollamaBaseUrl);
    this.model = model;
    // Gemma 4B is the dedicated vision model for reading terminal screenshots.
    // Falls back to the compression model if visionModel is not set.
    this.visionModel = visionModel ?? model;
  }

  async compress(event: RawEvent): Promise<CompressedEvent> {
    const eventDescription = this.formatEvent(event);

    try {
      const raw = await this.ollama.generate(
        this.model,
        `${COMPRESSION_PROMPT}\n\nRAW EVENT:\n${eventDescription}\n\nJSON:`,
        { temperature: 0.1, numPredict: 512, forceJson: true }
      );
      const parsed = this.parseResponse(raw);

      return {
        id: randomUUID(),
        time: event.timestamp,
        type: event.type,
        project: (event.data.project as string) || "unknown",
        file: (event.data.filePath as string) || null,
        summary: parsed.summary,
        concepts: parsed.concepts,
        significance: parsed.significance,
        error_verbatim: parsed.error_verbatim || null,
        resolution: parsed.resolution || null,
        resolves: null,
        embedding: null,
      };
    } catch {
      return this.fallbackCompress(event);
    }
  }

  /**
   * Vision-enhanced compression for terminal errors.
   * Uses Gemma 4's multimodal capability to read the actual terminal screenshot,
   * extracting the full error context before running the standard compress pass.
   */
  async compressWithVision(event: RawEvent, screenshotBase64: string): Promise<CompressedEvent> {
    try {
      const hint = event.data.command ? `Shell history recorded this command: ${event.data.command}` : "";
      const raw = await this.ollama.generateWithVision(
        this.visionModel,
        `${VISION_ERROR_PROMPT}\n\n${hint}`.trim(),
        screenshotBase64,
        { temperature: 0.1, numPredict: 512 }
      );

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const visual = JSON.parse(jsonMatch[0]) as {
          error_verbatim: string | null;
          file: string | null;
          command: string | null;
          context: string | null;
        };
        // Enrich the raw event data with what the model actually saw on screen
        if (visual.error_verbatim) event.data.error = visual.error_verbatim;
        if (visual.file && !event.data.filePath) event.data.filePath = visual.file;
        if (visual.command && !event.data.command) event.data.command = visual.command;
        if (visual.context) event.data.visualContext = visual.context;
        console.log("[Compressor] Vision enrichment applied to terminal error");
      }
    } catch (err) {
      console.warn("[Compressor] Vision enrichment failed, falling back to text-only:", err);
    }

    // Always finish with the full semantic compress pass on the (now enriched) event
    return this.compress(event);
  }

  private formatEvent(event: RawEvent): string {
    const parts = [`Type: ${event.type}`, `Time: ${event.timestamp}`, `Source: ${event.source}`];
    for (const [key, value] of Object.entries(event.data)) {
      if (value !== null && value !== undefined) {
        parts.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
    }
    return parts.join("\n");
  }

  private parseResponse(raw: string): {
    summary: string;
    concepts: string[];
    significance: number;
    error_verbatim: string | null;
    resolution: string | null;
  } {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in model response");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: String(parsed.summary || "No summary generated"),
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.map(String) : [],
      significance: Math.max(0, Math.min(1, parsed.significance != null ? Number(parsed.significance) : 0.5)),
      error_verbatim: parsed.error_verbatim ? String(parsed.error_verbatim) : null,
      resolution: parsed.resolution ? String(parsed.resolution) : null,
    };
  }

  private fallbackCompress(event: RawEvent): CompressedEvent {
    const significanceMap: Record<string, number> = {
      terminal_error: 0.8,
      file_save: 0.4,
      file_delete: 0.6,
      file_open: 0.2,
      window_focus: 0.1,
      terminal_command: 0.3,
      context_switch: 0.2,
      idle_timeout: 0.1,
      terminal_output: 0.3,
    };

    const filePath = event.data.filePath as string | undefined;
    const fileName = filePath ? filePath.split("/").pop() || filePath : null;
    const command = event.data.command as string | undefined;
    const app = event.data.app as string | undefined;
    const error = event.data.error as string | undefined;

    const summaryMap: Record<string, string> = {
      file_save:        fileName ? `Saved ${fileName}` : "Saved a file",
      file_open:        fileName ? `Opened ${fileName}` : "Opened a file",
      file_delete:      fileName ? `Deleted ${fileName}` : "Deleted a file",
      terminal_command: command  ? `Ran: ${command.slice(0, 80)}` : "Ran a command",
      terminal_error:   error    ? `Error: ${error.slice(0, 80)}` : "Terminal error",
      terminal_output:  "Terminal output",
      window_focus:     app      ? `Switched to ${app}` : "App switch",
      context_switch:   "Context switch",
      idle_timeout:     "Idle period",
    };

    return {
      id: randomUUID(),
      time: event.timestamp,
      type: event.type,
      project: (event.data.project as string) || "unknown",
      file: filePath || null,
      summary: summaryMap[event.type] || event.type,
      concepts: [],
      significance: significanceMap[event.type] || 0.3,
      error_verbatim: error || null,
      resolution: null,
      resolves: null,
      embedding: null,
    };
  }
}
