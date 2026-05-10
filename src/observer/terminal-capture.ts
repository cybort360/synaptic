import { eventBus } from "../shared/event-bus.js";
import type { RawEvent } from "../shared/types.js";
import { readFileSync, watchFile, unwatchFile } from "fs";
import { homedir } from "os";
import path from "path";
import { captureScreen } from "./screen-capture.js";

/**
 * Captures terminal activity by watching shell history files
 * and detecting error patterns in recent commands.
 *
 * This is the lightweight approach: read shell history rather than
 * spawning a PTY. Works with zsh (default on macOS) and bash.
 */
export class TerminalCapture {
  private historyPath: string;
  private lastLineCount = 0;
  private errorPatterns = [
    /error/i,
    /ERR!/,
    /FATAL/i,
    /TypeError/,
    /ReferenceError/,
    /SyntaxError/,
    /Cannot find module/,
    /ENOENT/,
    /EACCES/,
    /ECONNREFUSED/,
    /undefined is not/,
    /UnhandledPromiseRejection/,
    /panic:/,
    /fatal error:/i,
    /runtime error:/i,
    /deadlock/i,
    /exit status [1-9]/,
    /SIGSEGV/,
    /segmentation fault/i,
    /stack trace/i,
    /Traceback/,
    /null pointer/i,
    /out of memory/i,
    /thread '.*' panicked/,
    /mismatched types/i,
    /assertion (failed|error)/i,
    /command not found/i,
    /permission denied/i,
  ];

  constructor() {
    if (process.platform === "win32") {
      // PowerShell history on Windows
      this.historyPath = path.join(
        process.env.APPDATA ?? homedir(),
        "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"
      );
    } else {
      const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
      this.historyPath = shell.includes("zsh")
        ? path.join(homedir(), ".zsh_history")
        : path.join(homedir(), ".bash_history");
    }
  }

  start() {
    // Get initial line count so we only process new commands
    try {
      const content = readFileSync(this.historyPath, "utf-8");
      this.lastLineCount = content.split("\n").length;
    } catch {
      console.warn("[Observer/Terminal] Could not read history file, will retry");
      this.lastLineCount = 0;
    }

    // Poll history file for changes every 2 seconds
    watchFile(this.historyPath, { interval: 2000 }, () => {
      this.processNewCommands();
    });

    console.log(`[Observer/Terminal] Watching ${this.historyPath}`);
  }

  private async processNewCommands() {
    try {
      const content = readFileSync(this.historyPath, "utf-8");
      const lines = content.split("\n");
      const newLines = lines.slice(this.lastLineCount);
      this.lastLineCount = lines.length;

      for (const line of newLines) {
        if (!line.trim()) continue;

        // zsh history format: ": timestamp:0;command"
        const command = this.parseHistoryLine(line);
        if (!command) continue;

        const isError = this.errorPatterns.some((pattern) => pattern.test(command));

        // Capture the terminal screenshot at the moment the error is detected
        // so Gemma 4 vision can read the full stack trace / context visible on screen
        let screenshot: string | null = null;
        if (isError) {
          screenshot = await captureScreen();
          if (screenshot) console.log("[Observer/Terminal] Screenshot captured for vision analysis");
        }

        const event: RawEvent = {
          timestamp: new Date().toISOString(),
          type: isError ? "terminal_error" : "terminal_command",
          source: "terminal",
          data: {
            command,
            isError,
            project: "terminal",
            ...(screenshot ? { screenshot } : {}),
          },
        };

        eventBus.emitRawEvent(event);
      }
    } catch {
      // File may be temporarily locked during write
    }
  }

  private parseHistoryLine(line: string): string | null {
    // zsh format: ": 1234567890:0;actual command"
    const zshMatch = line.match(/^:\s*\d+:\d+;(.+)$/);
    if (zshMatch) return zshMatch[1];

    // bash format: just the command
    if (!line.startsWith(":") && !line.startsWith("#")) return line.trim();

    return null;
  }

  stop() {
    unwatchFile(this.historyPath);
    console.log("[Observer/Terminal] Stopped");
  }
}
