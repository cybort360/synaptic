const DEFAULT_BASE_URL = "http://localhost:11434";

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  format?: "json";
  images?: string[];
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
    stop?: string[];
  };
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
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
    const body: OllamaGenerateRequest = {
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
    });

    if (!response.ok) throw new Error(`Ollama error (${response.status}): ${await response.text()}`);
    const result = (await response.json()) as OllamaGenerateResponse;
    return result.response;
  }

  async *generateStream(
    model: string,
    prompt: string,
    opts: { temperature?: number; numPredict?: number; images?: string[] } = {}
  ): AsyncGenerator<string> {
    const body: OllamaGenerateRequest = {
      model, prompt, stream: true,
      ...(opts.images?.length ? { images: opts.images } : {}),
      options: {
        temperature: opts.temperature ?? 0.3,
        num_predict: opts.numPredict ?? 1024,
      },
    };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
          const data = JSON.parse(line) as OllamaGenerateResponse;
          if (data.response) yield data.response;
          if (data.done) return;
        } catch {}
      }
    }
  }

  async generateWithVision(
    model: string,
    prompt: string,
    imageBase64: string,
    opts: { temperature?: number; numPredict?: number } = {}
  ): Promise<string> {
    const body: OllamaGenerateRequest = {
      model, prompt, stream: false,
      images: [imageBase64],
      options: { temperature: opts.temperature ?? 0.1, num_predict: opts.numPredict ?? 512 },
    };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Ollama vision error (${response.status}): ${await response.text()}`);
    const result = (await response.json()) as OllamaGenerateResponse;
    return result.response;
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
