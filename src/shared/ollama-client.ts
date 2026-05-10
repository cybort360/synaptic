const DEFAULT_BASE_URL = "http://localhost:11434";

interface OllamaChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  format?: "json";
  options?: {
    temperature?: number;
    num_predict?: number;
    stop?: string[];
  };
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  done: boolean;
  error?: string;
}

interface OllamaTagsResponse {
  models: Array<{ name: string; size: number; modified_at: string }>;
}

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async generate(
    model: string,
    prompt: string,
    opts: { temperature?: number; numPredict?: number; stop?: string[]; forceJson?: boolean } = {}
  ): Promise<string> {
    // Uses /api/generate (not /api/chat) because format:"json" works correctly
    // with the generate endpoint for structured compression output, whereas
    // /api/chat with format:"json" causes gemma4 to return empty content.
    const body = {
      model, prompt, stream: false,
      ...(opts.forceJson ? { format: "json" } : {}),
      options: {
        temperature: opts.temperature ?? 0.1,
        num_predict: opts.numPredict ?? 512,
        ...(opts.stop ? { stop: opts.stop } : {}),
      },
    };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) throw new Error(`Ollama error (${response.status}): ${await response.text()}`);
    const result = await response.json() as { response?: string; error?: string };
    if (result.error) throw new Error(`Ollama: ${result.error}`);
    return result.response ?? "";
  }

  async *generateStream(
    model: string,
    prompt: string,
    opts: { temperature?: number; numPredict?: number; images?: string[] } = {}
  ): AsyncGenerator<string> {
    const msg: OllamaChatMessage = { role: "user", content: prompt };
    if (opts.images?.length) msg.images = opts.images;

    const body: OllamaChatRequest = {
      model,
      messages: [msg],
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.3,
        num_predict: opts.numPredict ?? 1024,
      },
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) throw new Error(`Ollama error (${response.status})`);

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
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line) as OllamaChatResponse;
          if (data.error) throw new Error(`Ollama: ${data.error}`);
          const token = data.message?.content;
          if (token) yield token;
          if (data.done) return;
        } catch (e) {
          if ((e as Error).message?.startsWith("Ollama:")) throw e;
        }
      }
    }
  }

  async generateWithVision(
    model: string,
    prompt: string,
    imageBase64: string,
    opts: { temperature?: number; numPredict?: number } = {}
  ): Promise<string> {
    const body: OllamaChatRequest = {
      model,
      messages: [{ role: "user", content: prompt, images: [imageBase64] }],
      stream: false,
      options: { temperature: opts.temperature ?? 0.1, num_predict: opts.numPredict ?? 512 },
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Ollama vision error (${response.status}): ${await response.text()}`);
    const result = (await response.json()) as OllamaChatResponse;
    if (result.error) throw new Error(`Ollama: ${result.error}`);
    return result.message?.content ?? "";
  }

  async embed(model: string, text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Ollama embed error (${response.status})`);
    const result = (await response.json()) as { embedding: number[] };
    return result.embedding;
  }

  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch { return false; }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];
      const data = (await response.json()) as OllamaTagsResponse;
      return data.models.map((m) => m.name);
    } catch { return []; }
  }
}
