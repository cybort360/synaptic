export interface RawEvent {
  timestamp: string;
  type: EventType;
  source: EventSource;
  data: Record<string, unknown>;
}

export type EventType =
  | "file_save"
  | "file_open"
  | "file_delete"
  | "terminal_command"
  | "terminal_error"
  | "terminal_output"
  | "window_focus"
  | "context_switch"
  | "idle_timeout";

export type EventSource = "file_watcher" | "terminal" | "window_monitor";

export interface CompressedEvent {
  id: string;
  time: string;
  type: EventType;
  project: string;
  file: string | null;
  summary: string;
  concepts: string[];
  significance: number;
  error_verbatim: string | null;
  resolution: string | null;
  resolves: string | null;
  embedding: number[] | null;
}

export interface Connection {
  id: string;
  source_event_id: string;
  target_event_id: string;
  relationship: string;
  confidence: number;
  discovered_at: string;
}

export interface QueryResult {
  query: string;
  mode?: QueryMode;
  relevant_events: CompressedEvent[];
  connections: Connection[];
  insight: string;
  grounded_in?: number;
  breadcrumb?: string[];
}

export type QueryMode = "translate" | "explain" | "map_concept" | "find_solution";

export interface HabitMismatch {
  pattern: string;
  oldLang: string;
  newLang: string;
  warning: string;
  trapType: string;
}

export interface ObserverStatus {
  watchers: Record<string, "active" | "paused" | "error" | "disabled">;
}

export interface SynapticConfig {
  watchPaths: string[];
  excludePatterns: string[];
  watchers: {
    files: boolean;
    terminal: boolean;
    windows: boolean;
    shellHistory: boolean;
  };
  fromLang: string;
  toLang: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  visionModel: string;
  ollamaReasoningModel: string;
  embeddingModel: string;
  reasoningModelApiKey: string;
  reasoningModelEndpoint: string;
  reasoningModel: string;
  dbPath: string;
  port: number;
  retentionDays: {
    low: number;
    medium: number;
    high: number;
  };
  socraticMode: boolean;
  socraticStrictness: "followup" | "gate";
}

export const DEFAULT_CONFIG: SynapticConfig = {
  watchPaths: [],
  excludePatterns: [
    "**/node_modules/**",
    "**/.git/**",
    "**/*.env",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.lock",
    "**/*.db",
  ],
  watchers: {
    files: true,
    terminal: true,
    windows: true,
    shellHistory: true,
  },
  fromLang: "",
  toLang: "",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "gemma4:e4b",
  visionModel: "gemma4:e4b",
  ollamaReasoningModel: "gemma4:e4b",
  embeddingModel: "nomic-embed-text",
  reasoningModelApiKey: "",
  reasoningModelEndpoint: "https://generativelanguage.googleapis.com/v1beta",
  reasoningModel: "gemini-2.0-flash",
  dbPath: "./synaptic.db",
  port: 3777,
  retentionDays: {
    low: 7,
    medium: 30,
    high: 365,
  },
  socraticMode: true,
  socraticStrictness: "followup",
};

export interface SocraticSession {
  id: string;
  filePath: string;
  fileLanguage: string | null;
  openedAt: string;
  history: SocraticTurn[];
  status: "open" | "passed" | "skipped";
  relevantConcepts: string[];
}

export interface SocraticTurn {
  role: "question" | "answer" | "evaluation";
  content: string;
  timestamp: string;
}

export interface SocraticGateEvent {
  filePath: string;
  fileLanguage: string | null;
  triggerType: "file_open" | "file_save";
}

export interface SocraticQuestionEvent {
  sessionId: string;
  filePath: string;
  question: string;
  turnIndex: number;
  isFollowUp: boolean;
  strictness: "followup" | "gate";
}

export interface SocraticResultEvent {
  sessionId: string;
  passed: boolean;
  feedback: string;
  totalTurns: number;
}
