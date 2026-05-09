import { FileWatcher } from "./file-watcher.js";
import { TerminalCapture } from "./terminal-capture.js";
import { StuckDetector } from "./stuck-detector.js";
import { WindowMonitor } from "./window-monitor.js";
import type { SynapticConfig } from "../shared/types.js";

export class Observer {
  private fileWatcher: FileWatcher;
  private terminalCapture: TerminalCapture;
  private stuckDetector: StuckDetector;
  private windowMonitor: WindowMonitor | null;

  constructor(config: SynapticConfig) {
    this.fileWatcher = new FileWatcher(config.watchPaths);
    this.terminalCapture = new TerminalCapture();
    this.stuckDetector = new StuckDetector();
    this.windowMonitor = (process.platform === "darwin" && config.watchers.windows)
      ? new WindowMonitor()
      : null;
  }

  start() {
    console.log("[Observer] Starting watchers...");
    this.fileWatcher.start();
    this.terminalCapture.start();
    this.stuckDetector.start();
    if (this.windowMonitor) {
      this.windowMonitor.start();
      console.log("[Observer] Window monitor active");
    }
    console.log("[Observer] Watchers active");
  }

  stop() {
    this.fileWatcher.stop();
    this.terminalCapture.stop();
    this.stuckDetector.stop();
    if (this.windowMonitor) this.windowMonitor.stop();
    console.log("[Observer] Stopped");
  }
}

export { FileWatcher, TerminalCapture, StuckDetector, WindowMonitor };
