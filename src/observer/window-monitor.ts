import { execSync } from "child_process";
import { eventBus } from "../shared/event-bus.js";
import type { RawEvent } from "../shared/types.js";

/**
 * Monitors active window changes on macOS using AppleScript.
 * Detects context switches between applications (VS Code, browser, terminal, etc.)
 */
export class WindowMonitor {
  private pollInterval: NodeJS.Timeout | null = null;
  private lastApp = "";
  private lastTitle = "";
  private pollMs: number;

  constructor(pollMs = 3000) {
    this.pollMs = pollMs;
  }

  start() {
    this.pollInterval = setInterval(() => {
      this.checkActiveWindow();
    }, this.pollMs);

    console.log("[Observer/WindowMonitor] Monitoring active window");
  }

  private checkActiveWindow() {
    if (process.platform !== "darwin") return;
    try {
      const appName = execSync(
        `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null`,
        { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();

      let windowTitle = "";
      try {
        windowTitle = execSync(
          `osascript -e 'tell application "System Events" to get name of front window of first application process whose frontmost is true' 2>/dev/null`,
          { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
      } catch {
        windowTitle = appName;
      }

      // Only emit if the context actually changed
      if (appName !== this.lastApp || windowTitle !== this.lastTitle) {
        const event: RawEvent = {
          timestamp: new Date().toISOString(),
          type: "window_focus",
          source: "window_monitor",
          data: {
            app: appName,
            windowTitle,
            previousApp: this.lastApp || null,
            previousTitle: this.lastTitle || null,
            category: this.categorizeApp(appName),
            project: "window",
          },
        };

        this.lastApp = appName;
        this.lastTitle = windowTitle;

        eventBus.emitRawEvent(event);
      }
    } catch {
      // AppleScript can fail if permissions aren't granted
      // User needs to allow Accessibility access
    }
  }

  private categorizeApp(appName: string): string {
    const lower = appName.toLowerCase();

    if (lower.includes("code") || lower.includes("cursor") || lower.includes("vim") || lower.includes("intellij") || lower.includes("webstorm")) {
      return "editor";
    }
    if (lower.includes("terminal") || lower.includes("iterm") || lower.includes("warp") || lower.includes("kitty") || lower.includes("alacritty")) {
      return "terminal";
    }
    if (lower.includes("chrome") || lower.includes("firefox") || lower.includes("safari") || lower.includes("arc") || lower.includes("brave")) {
      return "browser";
    }
    if (lower.includes("slack") || lower.includes("discord") || lower.includes("teams") || lower.includes("zoom")) {
      return "communication";
    }
    if (lower.includes("figma") || lower.includes("sketch")) {
      return "design";
    }
    if (lower.includes("finder") || lower.includes("explorer")) {
      return "file_manager";
    }

    return "other";
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log("[Observer/WindowMonitor] Stopped");
  }
}
