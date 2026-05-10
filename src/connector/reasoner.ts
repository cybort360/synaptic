import { OllamaClient } from "../shared/ollama-client.js";
import type { SynapticConfig } from "../shared/types.js";

export class Reasoner {
  private config: SynapticConfig;
  private ollama: OllamaClient;

  constructor(config: SynapticConfig) {
    this.config = config;
    this.ollama = new OllamaClient(config.ollamaBaseUrl);
  }

  async reason(prompt: string): Promise<string> {
    let full = "";
    for await (const token of this.reasonStream(prompt)) full += token;
    return full;
  }

  async *reasonStream(prompt: string, imageBase64?: string): AsyncGenerator<string> {
    if (this.config.reasoningModelApiKey) {
      try {
        yield* this.googleStream(prompt, imageBase64);
        return;
      } catch (err) {
        console.warn("[Reasoner] Google AI streaming failed, falling back to Ollama:", (err as Error).message);
      }
    }

    const models = [...new Set([this.config.ollamaReasoningModel, this.config.ollamaModel].filter(Boolean))];
    for (const model of models) {
      if (!model) continue;
      try {
        console.log(`[Reasoner] Streaming with: ${model}${imageBase64 ? " (vision)" : ""}`);
        yield* this.ollama.generateStream(model, prompt, {
          temperature: 0.3,
          numPredict: 1024,
          ...(imageBase64 ? { images: [imageBase64] } : {}),
        });
        return;
      } catch {
        console.warn(`[Reasoner] ${model} unavailable, trying fallback...`);
      }
    }

    throw new Error("No available model for reasoning");
  }

  private async *googleStream(prompt: string, imageBase64?: string): AsyncGenerator<string> {
    const url = `${this.config.reasoningModelEndpoint}/models/${this.config.reasoningModel}:streamGenerateContent?key=${this.config.reasoningModelApiKey}&alt=sse`;

    const parts: object[] = [{ text: prompt }];
    if (imageBase64) parts.push({ inlineData: { mimeType: "image/png", data: imageBase64 } });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
    });

    if (!response.ok) throw new Error(`Google AI error (${response.status}): ${await response.text()}`);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") return;
        try {
          const parsed = JSON.parse(raw);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch {}
      }
    }
  }
}
