import { FileWatcher } from "./file-watcher.js";
import { TerminalCapture } from "./terminal-capture.js";
import { StuckDetector } from "./stuck-detector.js";

export class Observer {
  private fileWatcher: FileWatcher;
  private terminalCapture: TerminalCapture;
  private stuckDetector: StuckDetector;

  constructor(watchPaths: string[]) {
    this.fileWatcher = new FileWatcher(watchPaths);
    this.terminalCapture = new TerminalCapture();
    this.stuckDetector = new StuckDetector();
  }

  start() {
    console.log("[Observer] Starting file + terminal watchers...");
    this.fileWatcher.start();
    this.terminalCapture.start();
    this.stuckDetector.start();
    console.log("[Observer] Watchers active");
  }

  stop() {
    this.fileWatcher.stop();
    this.terminalCapture.stop();
    this.stuckDetector.stop();
    console.log("[Observer] Stopped");
  }
}

export { FileWatcher, TerminalCapture, StuckDetector };
