import chokidar, { type FSWatcher } from "chokidar";
import { eventBus } from "../shared/event-bus.js";
import type { RawEvent } from "../shared/types.js";
import path from "path";
import { readFileSync } from "fs";

/**
 * Watches project directories for file changes.
 * Debounces rapid saves and emits structured events.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs: number;

  constructor(private watchPaths: string[], debounceMs = 1000) {
    this.debounceMs = debounceMs;
  }

  start() {
    // Chokidar v4 dropped glob support for `ignored` — strings now do exact
    // equality matching only. Use a function with regex instead.
    const IGNORED_RE = /[/\\](node_modules|\.git|dist|build|\.next|coverage)[/\\]|\.lock$/;
    this.watcher = chokidar.watch(this.watchPaths, {
      ignored: (p: string) => IGNORED_RE.test(p),
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on("change", (filePath: string) => { console.log(`[FileWatcher] change: ${filePath}`); this.handleChange(filePath, "file_save"); });
    this.watcher.on("add", (filePath: string) => { console.log(`[FileWatcher] add: ${filePath}`); this.handleChange(filePath, "file_open"); });
    this.watcher.on("unlink", (filePath: string) => { console.log(`[FileWatcher] delete: ${filePath}`); this.handleChange(filePath, "file_delete"); });

    console.log(`[Observer/FileWatcher] Watching ${this.watchPaths.length} paths`);
  }

  private handleChange(filePath: string, type: RawEvent["type"]) {
    // Debounce rapid saves to the same file
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      let content: string | undefined;
      if (type !== "file_delete") {
        try {
          const raw = readFileSync(filePath, "utf-8");
          // Cap at 4000 chars so the prompt stays reasonable
          content = raw.length > 4000 ? raw.slice(0, 4000) + "\n... (truncated)" : raw;
        } catch { /* binary or unreadable file */ }
      }

      const event: RawEvent = {
        timestamp: new Date().toISOString(),
        type,
        source: "file_watcher",
        data: {
          filePath,
          fileName: path.basename(filePath),
          extension: path.extname(filePath),
          project: this.inferProject(filePath),
          ...(content !== undefined && { content }),
        },
      };

      eventBus.emitRawEvent(event);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  private inferProject(filePath: string): string {
    // Walk up the directory tree to find the nearest package.json or .git
    const parts = filePath.split(path.sep);
    for (let i = parts.length - 1; i >= 0; i--) {
      const dir = parts.slice(0, i + 1).join(path.sep);
      // In production, we'd check for package.json/.git existence
      // For now, use the deepest directory that looks like a project root
      if (parts[i] === "src" || parts[i] === "packages") {
        return parts[i - 1] || "unknown";
      }
    }
    return parts[parts.length - 2] || "unknown";
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
    console.log("[Observer/FileWatcher] Stopped");
  }
}
