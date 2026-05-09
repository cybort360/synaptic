import { eventBus } from "../shared/event-bus.js";
import type { RawEvent } from "../shared/types.js";

/**
 * Detects when the developer is "stuck" based on behavioral signals:
 * - Same file edited repeatedly without progress
 * - Rapid terminal command repetition (re-running failing tests)
 * - Long pauses followed by rapid context switching
 * - Multiple error events in a short window
 */
export class StuckDetector {
  private recentEvents: Array<{ event: RawEvent; time: number }> = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private windowMs = 5 * 60 * 1000; // 5-minute analysis window
  private checkMs = 30_000; // Check every 30 seconds

  // Thresholds
  private readonly ERROR_THRESHOLD = 3; // 3+ errors in window = likely stuck
  private readonly REPEAT_COMMAND_THRESHOLD = 3; // same command 3+ times
  private readonly RAPID_SWITCH_THRESHOLD = 6; // 6+ window switches in window

  start() {
    // Collect all events into the rolling window
    eventBus.onRawEvent((event) => {
      this.recentEvents.push({ event, time: Date.now() });
      this.pruneOldEvents();
    });

    // Periodically analyze the window
    this.checkInterval = setInterval(() => {
      this.analyze();
    }, this.checkMs);

    console.log("[Observer/StuckDetector] Monitoring for stuck signals");
  }

  private pruneOldEvents() {
    const cutoff = Date.now() - this.windowMs;
    this.recentEvents = this.recentEvents.filter((e) => e.time > cutoff);
  }

  private analyze() {
    if (this.recentEvents.length < 3) return;

    const signals: string[] = [];

    // Signal 1: Multiple errors
    const errors = this.recentEvents.filter((e) => e.event.type === "terminal_error");
    if (errors.length >= this.ERROR_THRESHOLD) {
      signals.push(`${errors.length} errors in the last 5 minutes`);
    }

    // Signal 2: Repeated commands
    const commands = this.recentEvents
      .filter((e) => e.event.type === "terminal_command")
      .map((e) => e.event.data.command as string);

    const commandCounts = new Map<string, number>();
    for (const cmd of commands) {
      commandCounts.set(cmd, (commandCounts.get(cmd) || 0) + 1);
    }
    for (const [cmd, count] of commandCounts) {
      if (count >= this.REPEAT_COMMAND_THRESHOLD) {
        signals.push(`Command "${cmd}" repeated ${count} times`);
      }
    }

    // Signal 3: Rapid context switching
    const windowSwitches = this.recentEvents.filter((e) => e.event.type === "window_focus");
    if (windowSwitches.length >= this.RAPID_SWITCH_THRESHOLD) {
      signals.push(`${windowSwitches.length} app switches in 5 minutes`);
    }

    // Signal 4: Same file saved many times (thrashing)
    const saves = this.recentEvents
      .filter((e) => e.event.type === "file_save")
      .map((e) => e.event.data.filePath as string);

    const saveCounts = new Map<string, number>();
    for (const f of saves) {
      saveCounts.set(f, (saveCounts.get(f) || 0) + 1);
    }
    for (const [file, count] of saveCounts) {
      if (count >= 5) {
        signals.push(`File "${file}" saved ${count} times (thrashing)`);
      }
    }

    // If 2+ signals are active, the developer is likely stuck
    if (signals.length >= 2) {
      const currentFile = this.getMostRecentFile();
      const duration = (Date.now() - this.recentEvents[0].time) / 1000 / 60;

      eventBus.emitStuckDetected({
        file: currentFile,
        duration: Math.round(duration),
        signals,
      });

      // Reset window after detection to avoid repeat alerts
      this.recentEvents = [];
    }
  }

  private getMostRecentFile(): string | null {
    for (let i = this.recentEvents.length - 1; i >= 0; i--) {
      const filePath = this.recentEvents[i].event.data.filePath as string | undefined;
      if (filePath) return filePath;
    }
    return null;
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("[Observer/StuckDetector] Stopped");
  }
}
