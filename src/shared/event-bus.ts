import { EventEmitter } from "events";
import type {
  RawEvent, CompressedEvent, QueryResult, HabitMismatch, ObserverStatus,
  SocraticGateEvent, SocraticQuestionEvent, SocraticResultEvent
} from "./types.js";

class SynapticEventBus extends EventEmitter {
  emitRawEvent(event: RawEvent) { this.emit("raw_event", event); }
  emitCompressedEvent(event: CompressedEvent) { this.emit("compressed_event", event); }
  emitQueryResult(result: QueryResult) { this.emit("query_result", result); }
  emitStuckDetected(context: { file: string | null; duration: number; signals: string[] }) {
    this.emit("stuck_detected", context);
  }
  emitHabitMismatch(mismatch: HabitMismatch) { this.emit("habit_mismatch", mismatch); }
  emitObserverStatus(status: ObserverStatus) { this.emit("observer_status", status); }

  onRawEvent(handler: (event: RawEvent) => void) { this.on("raw_event", handler); }
  onCompressedEvent(handler: (event: CompressedEvent) => void) { this.on("compressed_event", handler); }
  onQueryResult(handler: (result: QueryResult) => void) { this.on("query_result", handler); }
  onStuckDetected(handler: (context: { file: string | null; duration: number; signals: string[] }) => void) {
    this.on("stuck_detected", handler);
  }
  onHabitMismatch(handler: (mismatch: HabitMismatch) => void) { this.on("habit_mismatch", handler); }
  onObserverStatus(handler: (status: ObserverStatus) => void) { this.on("observer_status", handler); }

  emitSocraticGate(event: SocraticGateEvent) { this.emit("socratic_gate", event); }
  emitSocraticQuestion(event: SocraticQuestionEvent) { this.emit("socratic_question", event); }
  emitSocraticResult(event: SocraticResultEvent) { this.emit("socratic_result", event); }

  onSocraticGate(handler: (event: SocraticGateEvent) => void) { this.on("socratic_gate", handler); }
  onSocraticQuestion(handler: (event: SocraticQuestionEvent) => void) { this.on("socratic_question", handler); }
  onSocraticResult(handler: (event: SocraticResultEvent) => void) { this.on("socratic_result", handler); }
}

export const eventBus = new SynapticEventBus();
