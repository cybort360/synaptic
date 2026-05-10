import { randomUUID } from "crypto";
import type { Archivist } from "../archivist/index.js";
import type { Reasoner } from "../connector/reasoner.js";
import type {
  SynapticConfig,
  SocraticSession,
  SocraticTurn,
  SocraticGateEvent,
  SocraticQuestionEvent,
  SocraticResultEvent,
} from "../shared/types.js";
import { eventBus } from "../shared/event-bus.js";
import { buildSocraticPrompt, buildSocraticEvalPrompt } from "../connector/prompts.js";

const MAX_TURNS = 3;

export class SocraticEngine {
  private sessions = new Map<string, SocraticSession>();

  constructor(
    private archivist: Archivist,
    private reasoner: Reasoner,
    private config: SynapticConfig
  ) {}

  async startSession(gate: SocraticGateEvent): Promise<void> {
    if (!this.config.socraticMode) return;

    // Guard: skip if already have an open session for this file
    for (const existing of this.sessions.values()) {
      if (existing.filePath === gate.filePath && existing.status === "open") {
        console.log(`[Socratic] Skipping duplicate session for ${gate.filePath}`);
        return;
      }
    }

    const sessionId = randomUUID();
    const history: SocraticTurn[] = [];

    const recentContext = this.archivist.getActiveContext(24);
    const fileMemories = await this.archivist.semanticSearch(gate.filePath, 8);

    const relevantConcepts = [
      ...new Set([
        ...recentContext.flatMap((e) => e.concepts),
        ...fileMemories.flatMap((e) => e.concepts),
      ]),
    ].slice(0, 20);

    const prompt = buildSocraticPrompt({
      filePath: gate.filePath,
      fileLanguage: gate.fileLanguage,
      recentContext,
      fileMemories,
      conversationHistory: [],
      developerAnswer: null,
    });

    let question: string;
    try {
      question = await this.reasoner.reason(prompt);
      question = question.trim();
    } catch {
      console.warn("[Socratic] Failed to generate opening question, skipping session");
      return;
    }

    const turn: SocraticTurn = {
      role: "question",
      content: question,
      timestamp: new Date().toISOString(),
    };
    history.push(turn);

    const session: SocraticSession = {
      id: sessionId,
      filePath: gate.filePath,
      fileLanguage: gate.fileLanguage,
      openedAt: new Date().toISOString(),
      history,
      status: "open",
      relevantConcepts,
    };

    this.sessions.set(sessionId, session);

    const questionEvent: SocraticQuestionEvent = {
      sessionId,
      filePath: gate.filePath,
      question,
      turnIndex: 0,
      isFollowUp: false,
      strictness: this.config.socraticStrictness,
    };
    eventBus.emitSocraticQuestion(questionEvent);

    console.log(`[Socratic] Session ${sessionId} started for ${gate.filePath}`);
  }

  async respondToSession(sessionId: string, developerAnswer: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "open") return;

    const answerTurn: SocraticTurn = {
      role: "answer",
      content: developerAnswer,
      timestamp: new Date().toISOString(),
    };
    session.history.push(answerTurn);

    const questionCount = session.history.filter((t) => t.role === "question").length;

    const recentContext = this.archivist.getActiveContext(24);
    const fileMemories = await this.archivist.semanticSearch(session.filePath, 8);

    const evalPrompt = buildSocraticEvalPrompt({
      filePath: session.filePath,
      fileLanguage: session.fileLanguage,
      recentContext,
      fileMemories,
      conversationHistory: session.history,
      developerAnswer,
    });

    let evalRaw: string;
    try {
      evalRaw = await this.reasoner.reason(evalPrompt);
    } catch {
      this.closeSession(session, true, "Model unavailable — session auto-passed.");
      return;
    }

    let passed = false;
    let feedback = "";
    let followUp: string | undefined;

    try {
      const jsonMatch = evalRaw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          passed: boolean;
          feedback: string;
          followUp?: string;
        };
        passed = Boolean(parsed.passed);
        feedback = String(parsed.feedback || "");
        followUp = parsed.followUp;
      }
    } catch {
      passed = /\b(correct|good|yes|solid|clear|right|great)\b/i.test(evalRaw);
      feedback = evalRaw.slice(0, 300);
    }

    const evalTurn: SocraticTurn = {
      role: "evaluation",
      content: feedback,
      timestamp: new Date().toISOString(),
    };
    session.history.push(evalTurn);

    if (passed || questionCount >= MAX_TURNS) {
      this.closeSession(session, true, feedback);
    } else if (followUp) {
      const followUpTurn: SocraticTurn = {
        role: "question",
        content: followUp,
        timestamp: new Date().toISOString(),
      };
      session.history.push(followUpTurn);

      const questionEvent: SocraticQuestionEvent = {
        sessionId,
        filePath: session.filePath,
        question: followUp,
        turnIndex: questionCount,
        isFollowUp: true,
        strictness: this.config.socraticStrictness,
      };
      eventBus.emitSocraticQuestion(questionEvent);
    } else {
      this.closeSession(session, false, feedback);
    }
  }

  skipSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = "skipped";
    const result: SocraticResultEvent = {
      sessionId,
      passed: false,
      feedback: "Session skipped.",
      totalTurns: session.history.filter((t) => t.role === "question").length,
    };
    eventBus.emitSocraticResult(result);
    console.log(`[Socratic] Session ${sessionId} skipped.`);
  }

  getSession(sessionId: string): SocraticSession | undefined {
    return this.sessions.get(sessionId);
  }

  private closeSession(session: SocraticSession, passed: boolean, feedback: string): void {
    session.status = passed ? "passed" : "skipped";
    const result: SocraticResultEvent = {
      sessionId: session.id,
      passed,
      feedback,
      totalTurns: session.history.filter((t) => t.role === "question").length,
    };
    eventBus.emitSocraticResult(result);
    console.log(`[Socratic] Session ${session.id} closed — passed=${passed}`);
  }
}
