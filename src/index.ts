import { Observer } from "./observer/index.js";
import { Archivist } from "./archivist/index.js";
import { Connector } from "./connector/index.js";
import { createServer } from "./server.js";
import { DEFAULT_CONFIG } from "./shared/types.js";
import { OllamaClient } from "./shared/ollama-client.js";
import type { SynapticConfig } from "./shared/types.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

async function main() {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║          SYNAPTIC v1.0                ║
  ║   Your AI Dev Companion (Local-First) ║
  ╚═══════════════════════════════════════╝
  `);

  const config = loadConfig();

  // Check Ollama availability
  const ollama = new OllamaClient(config.ollamaBaseUrl);
  const ollamaReady = await ollama.isRunning();
  if (!ollamaReady) {
    console.warn(
      `\n[WARNING] Ollama not running at ${config.ollamaBaseUrl}\n` +
        `  Install: https://ollama.com\n` +
        `  Then run: ollama pull ${config.ollamaModel}\n` +
        `  Synaptic will use fallback compression until Ollama is available.\n`
    );
  } else {
    const models = await ollama.listModels();
    if (!models.some((m) => m.startsWith(config.ollamaModel.split(":")[0]))) {
      console.warn(`\n[WARNING] Model ${config.ollamaModel} not found. Run: ollama pull ${config.ollamaModel}\n`);
    }
  }

  const archivist = new Archivist(config);
  await archivist.init();
  const connector = new Connector(config, archivist);
  const observer = new Observer(config);

  archivist.start();
  connector.start();
  observer.start();

  const server = createServer(connector, archivist, config);

  console.log(`\n[Synaptic] Dashboard: http://localhost:${config.port}`);
  console.log(`[Synaptic] Watching ${config.watchPaths.length} paths`);
  console.log(`[Synaptic] Press Ctrl+C to stop\n`);

  const shutdown = () => {
    console.log("\n[Synaptic] Shutting down...");
    observer.stop();
    archivist.stop();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function loadConfig(): SynapticConfig {
  const configPath = path.resolve("synaptic.config.json");
  let config: SynapticConfig = { ...DEFAULT_CONFIG, watchers: { ...DEFAULT_CONFIG.watchers } };

  if (existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<SynapticConfig>;
      config = {
        ...config,
        ...userConfig,
        watchers: { ...config.watchers, ...(userConfig.watchers ?? {}) },
        retentionDays: { ...config.retentionDays, ...(userConfig.retentionDays ?? {}) },
      };
      console.log("[Config] Loaded from synaptic.config.json");
    } catch {
      console.warn("[Config] Failed to parse synaptic.config.json, using defaults");
    }
  } else {
    // Write default config on first run
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log("[Config] Created synaptic.config.json with defaults");
  }

  if (process.env.AI_API_KEY) config.reasoningModelApiKey = process.env.AI_API_KEY;
  if (process.env.WATCH_PATHS) config.watchPaths = process.env.WATCH_PATHS.split(",").map((p) => p.trim());
  if (config.watchPaths.length === 0) config.watchPaths = [process.cwd()];

  return config;
}

main().catch((error) => {
  console.error("[Synaptic] Fatal error:", error);
  process.exit(1);
});
