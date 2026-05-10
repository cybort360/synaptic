import chokidar, { type FSWatcher } from "chokidar";
import { eventBus } from "../shared/event-bus.js";
import type { RawEvent, SynapticConfig } from "../shared/types.js";
import { BridgeEngine } from "../mentor/bridge-engine.js";
import path from "path";
import { readFileSync } from "fs";

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/\\\\]*";
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re);
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private socraticDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs: number;

  constructor(private watchPaths: string[], debounceMs = 1000, private config?: SynapticConfig) {
    this.debounceMs = debounceMs;
  }

  start() {
    // Chokidar v4 dropped glob support for `ignored` — use a predicate built from config.excludePatterns.
    const excludePatterns = this.config?.excludePatterns ?? [];
    const excludeRegexes = excludePatterns.map(globToRegex);
    const isIgnored = (p: string) => excludeRegexes.some((re) => re.test(p));

    this.watcher = chokidar.watch(this.watchPaths, {
      ignored: isIgnored,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on("change", (filePath: string) => { console.log(`[FileWatcher] change: ${filePath}`); this.handleChange(filePath, "file_save"); });
    this.watcher.on("add", (filePath: string) => { console.log(`[FileWatcher] add: ${filePath}`); this.handleChange(filePath, "file_open"); });
    this.watcher.on("unlink", (filePath: string) => { console.log(`[FileWatcher] delete: ${filePath}`); this.handleChange(filePath, "file_delete"); });

    console.log(`[Observer/FileWatcher] Watching ${this.watchPaths.length} paths`);
  }

  private handleChange(filePath: string, type: RawEvent["type"]) {
    // Cancel any pending socratic gate timer for this path on any event
    const pendingSocratic = this.socraticDebounceTimers.get(filePath);
    if (pendingSocratic) {
      clearTimeout(pendingSocratic);
      this.socraticDebounceTimers.delete(filePath);
    }

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

      // Socratic gate: fire on file_open (new file) or file_save (editing session)
      if ((type === "file_open" || type === "file_save") && this.config?.socraticMode) {
        const fileLanguage = BridgeEngine.detectLang(filePath);
        if (fileLanguage !== null) {
          const socraticTimer = setTimeout(() => {
            this.socraticDebounceTimers.delete(filePath);
            eventBus.emitSocraticGate({
              filePath,
              fileLanguage,
              triggerType: type === "file_open" ? "file_open" : "file_save",
            });
          }, 500);
          this.socraticDebounceTimers.set(filePath, socraticTimer);
        }
      }
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  private inferProject(filePath: string): string {
    // Match against known watch paths first — most reliable signal
    for (const watchPath of this.watchPaths) {
      if (filePath.startsWith(watchPath + path.sep) || filePath === watchPath) {
        return path.basename(watchPath);
      }
    }
    // Fall back to the directory that contains a src/ or packages/ folder
    const parts = filePath.split(path.sep);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === "src" || parts[i] === "packages") {
        return parts[i - 1] || "unknown";
      }
    }
    return parts[parts.length - 2] || "unknown";
  }

  addPaths(newPaths: string[]) {
    if (!this.watcher) return;
    const fresh = newPaths.filter(p => !this.watchPaths.includes(p));
    if (!fresh.length) return;
    this.watcher.add(fresh);
    this.watchPaths.push(...fresh);
    console.log(`[Observer/FileWatcher] Added ${fresh.length} new path(s): ${fresh.join(", ")}`);
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
    this.socraticDebounceTimers.forEach((timer) => clearTimeout(timer));
    this.socraticDebounceTimers.clear();
    console.log("[Observer/FileWatcher] Stopped");
  }
}
