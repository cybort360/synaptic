import type { CompressedEvent } from "../shared/types.js";

type LangCtx = { from: string; to: string } | null;

function langLine(ctx: LangCtx): string {
  if (!ctx?.from || !ctx?.to) return "";
  return `\nDEVELOPER CONTEXT: Migrating from ${ctx.from} to ${ctx.to}.\n`;
}

export function buildConnectionPrompt(
  currentContext: CompressedEvent[],
  retrievedMemories: CompressedEvent[],
  query: string,
  lang: LangCtx = null
): string {
  const contextBlock = currentContext
    .map((e) => `[${e.time}] ${e.type} | ${e.file || "no file"} | ${e.summary} | concepts: ${e.concepts.join(", ")}`)
    .join("\n");

  const memoriesBlock = retrievedMemories
    .map((e) => `[${e.time}] ${e.type} | ${e.file || "no file"} | ${e.summary} | concepts: ${e.concepts.join(", ")}${e.error_verbatim ? ` | error: ${e.error_verbatim}` : ""}${e.resolution ? ` | fix: ${e.resolution}` : ""}`)
    .join("\n");

  return `You are Synaptic, a developer's second brain.${langLine(lang)}
Your job: find meaningful connections between what they're doing NOW and what they've done BEFORE. Surface forgotten solutions, recurring patterns, and non-obvious relationships.

RULES:
- Be specific. Reference exact file paths, error messages, and concepts.
- Only surface connections you're confident about (don't fabricate).
- If you find a past solution to a current problem, lead with that.
- If you notice a recurring pattern (same type of bug, same conceptual struggle), mention it.
- If you see a library or concept that maps to something they already know, explain the mapping.
- Keep your response under 200 words. Be dense and useful.

CURRENT ACTIVITY (last 2 hours):
${contextBlock || "No recent activity recorded."}

RETRIEVED MEMORIES (from past sessions):
${memoriesBlock || "No relevant memories found."}

DEVELOPER'S QUESTION:
${query}

Answer the question directly and specifically. If the retrieved memories are not relevant to the question, ignore them — do not summarize unrelated context. Do not give unsolicited advice about patterns you observe in the activity. Stay focused on what was asked.`;
}

export function buildExplainPrompt(
  query: string,
  retrievedMemories: CompressedEvent[],
  lang: LangCtx = null
): string {
  const langLine2 = lang?.from && lang?.to
    ? `The developer is coming from ${lang.from} and learning ${lang.to}. Use ${lang.from} analogies where helpful.`
    : "";

  const memBlock = retrievedMemories
    .slice(0, 5)
    .map((e) => `- ${e.summary}${e.error_verbatim ? ` (error: ${e.error_verbatim})` : ""}`)
    .join("\n");

  return `Explain "${query}" clearly and concisely to a developer.
${langLine2}

Do NOT give project advice or code review. Do NOT summarize what the developer has been doing.
Just explain what "${query}" IS and why it matters.

${memBlock ? `For context, the developer has worked with:\n${memBlock}\n\nUse this to make the explanation concrete and relevant to their actual work.` : ""}

Structure your answer using these exact headers:

## WHAT IT IS
[one clear sentence]

## HOW IT WORKS
[2-3 sentences on the mechanism]

## WHY IT MATTERS
[one sentence on the practical benefit]

## EXAMPLE
\`\`\`
[a short concrete code example]
\`\`\``;
}

export function buildStuckAssistancePrompt(
  currentContext: CompressedEvent[],
  retrievedMemories: CompressedEvent[],
  stuckSignals: string[],
  lang: LangCtx = null
): string {
  const contextBlock = currentContext
    .map((e) => `[${e.time}] ${e.type} | ${e.file || "no file"} | ${e.summary}${e.error_verbatim ? ` | error: ${e.error_verbatim}` : ""}`)
    .join("\n");

  const memoriesBlock = retrievedMemories
    .map((e) => `[${e.time}] ${e.summary}${e.resolution ? ` → FIX: ${e.resolution}` : ""}`)
    .join("\n");

  return `You are Synaptic, a developer's second brain.${langLine(lang)}The developer appears to be stuck.

STUCK SIGNALS DETECTED:
${stuckSignals.map((s) => `- ${s}`).join("\n")}

RECENT ACTIVITY:
${contextBlock}

POSSIBLY RELEVANT PAST EXPERIENCES:
${memoriesBlock || "No matching memories found."}

Based on the signals and context:
1. Identify what they're likely struggling with
2. If a past memory contains a relevant solution, surface it with the specific fix
3. If no past memory applies, suggest a concrete next step based on the error patterns

Be brief (under 150 words), specific, and helpful. Don't be patronizing.`;
}

export function buildTranslatePrompt(
  question: string,
  fromLang: string | undefined,
  toLang: string | undefined,
  relevantMemories: CompressedEvent[]
): string {
  const from = fromLang || "the source language";
  const to = toLang || "the target language";

  const memoriesBlock = relevantMemories
    .map((e) => `[${e.file || "unknown file"}] ${e.summary}${e.error_verbatim ? ` | error: ${e.error_verbatim}` : ""}${e.resolution ? ` | fix: ${e.resolution}` : ""}`)
    .join("\n");

  return `You are Synaptic. Translate this coding concept from ${from} to ${to}, grounded in the developer's own codebase.

QUESTION: ${question}

DEVELOPER'S RELEVANT CODE HISTORY:
${memoriesBlock || "No specific history found — use general knowledge."}

Respond with:
01 TRANSLATION
[show the idiomatic ${to} equivalent with a brief explanation of WHY it works this way]

02 FROM YOUR OWN CODE
[reference a specific pattern from their history — show the analogy side by side if possible]

03 WATCH OUT FOR
[one specific trap a ${from} developer commonly hits in ${to} — be concrete, name the exact misconception]

Code blocks required. Be concise and precise.`;
}

export function buildHabitMismatchPrompt(
  recentCode: string,
  fromLang: string,
  toLang: string,
  knownPatterns: string[]
): string {
  return `You are Synaptic analyzing developer code for habit mismatches — patterns from ${fromLang} that don't translate correctly to ${toLang}.

RECENT CODE/ACTIVITY:
${recentCode}

KNOWN DEVELOPER PATTERNS (from history):
${knownPatterns.slice(0, 10).join("\n")}

Look for habits specific to ${fromLang} that are wrong in ${toLang}:
- Syntax that exists in ${fromLang} but not ${toLang}
- Error handling approaches that differ fundamentally
- Concurrency/async models that are conceptually different
- Type system assumptions that don't carry over
- Standard library functions with different names or semantics

Reply with JSON only:
{
  "found": true,
  "pattern": "the exact pattern from ${fromLang} found in the code",
  "oldLang": "${fromLang}",
  "newLang": "${toLang}",
  "warning": "why this fails in ${toLang} and what to use instead",
  "trapType": "ERROR_HANDLING | ASYNC | NULL_SAFETY | TYPE_SYSTEM | WRONG_BUILTIN | SYNTAX | OTHER"
}

If no mismatch found: { "found": false }`;
}

interface SocraticPromptInput {
  filePath: string;
  fileLanguage: string | null;
  recentContext: CompressedEvent[];
  fileMemories: CompressedEvent[];
  conversationHistory: { role: string; content: string }[];
  developerAnswer: string | null;
}

export function buildSocraticPrompt(input: SocraticPromptInput): string {
  const { filePath, fileLanguage, recentContext, fileMemories, conversationHistory } = input;

  const lang = fileLanguage || "code";

  const recentBlock = recentContext
    .slice(0, 10)
    .map((e) => `- [${e.type}] ${e.summary} (concepts: ${e.concepts.join(", ")})`)
    .join("\n");

  const memoryBlock = fileMemories
    .slice(0, 5)
    .map((e) => `- ${e.summary}${e.error_verbatim ? ` | past error: ${e.error_verbatim}` : ""}${e.resolution ? ` | fix: ${e.resolution}` : ""}`)
    .join("\n");

  const historyBlock = conversationHistory.length > 0
    ? conversationHistory.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n")
    : "";

  return `You are Synaptic's Socratic tutor. A developer just opened ${filePath} (${lang}).

Your job: ask ONE targeted question that makes them articulate their intent before they write code. The question must be:
- Specific to this file and language (not generic)
- Grounded in what this developer actually knows from their history
- Probing a real decision point — types, architecture, error handling, performance — not trivia
- Short: one sentence, ending with a question mark
- Not a yes/no question

DEVELOPER'S RECENT ACTIVITY:
${recentBlock || "No recent activity."}

MEMORIES RELATED TO THIS FILE:
${memoryBlock || "No prior history for this file."}

${historyBlock ? `CONVERSATION SO FAR:\n${historyBlock}\n` : ""}Output ONLY the question. No preamble, no explanation, no quotes.`;
}

export function buildSocraticEvalPrompt(input: SocraticPromptInput): string {
  const { filePath, fileLanguage, recentContext, fileMemories, conversationHistory, developerAnswer } = input;

  const lang = fileLanguage || "code";

  const recentBlock = recentContext
    .slice(0, 8)
    .map((e) => `- [${e.type}] ${e.summary} (concepts: ${e.concepts.join(", ")})`)
    .join("\n");

  const memoryBlock = fileMemories
    .slice(0, 4)
    .map((e) => `- ${e.summary}`)
    .join("\n");

  const historyBlock = conversationHistory
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n");

  return `You are Synaptic's Socratic evaluator. A developer is explaining their approach to ${filePath} (${lang}) before writing code.

DEVELOPER'S RECENT HISTORY:
${recentBlock || "No recent activity."}

FILE MEMORIES:
${memoryBlock || "No prior history for this file."}

CONVERSATION:
${historyBlock}

LATEST DEVELOPER ANSWER:
${developerAnswer}

Evaluate the explanation. Is it clear enough to suggest they understand what they're about to do?

Scoring guide:
- PASS: They named the specific approach, described at least one design decision, and mentioned a potential failure mode or edge case.
- FOLLOW-UP needed: They gave a vague answer ("I'll add some logic here"), skipped a key decision, or repeated the question back.
- FOLLOW-UP needed: They don't mention error handling, types, or edge cases at all for a non-trivial change.

Reply with JSON only:
{
  "passed": true or false,
  "feedback": "one sentence — either confirming what was good, or specifically what was missing",
  "followUp": "if passed=false, one specific follow-up question targeting the gap. If passed=true, omit this field."
}`;
}

export function buildMentalMapPrompt(
  newConcept: string,
  knownConcepts: string[],
  lang: LangCtx = null
): string {
  const langLine = lang?.from && lang?.to
    ? `The developer knows ${lang.from} and is learning ${lang.to}. Use ${lang.from} analogies where possible.`
    : "";

  const conceptList = knownConcepts.slice(0, 20).map((c) => `- ${c}`).join("\n");

  return `You are explaining the concept "${newConcept}" to a developer. Use only their existing knowledge as anchors.
${langLine}

Their known concepts:
${conceptList}

Reply using these exact headers — no preamble, no advice, just the explanation:

## WHAT IT IS
[one sentence defining "${newConcept}"]

## CLOSEST MATCH
[name one concept from the list] — [one sentence on why they are similar]

## KEY DIFFERENCE
[one sentence on what makes "${newConcept}" distinct]

## EXAMPLE
\`\`\`
[2-4 lines of code showing "${newConcept}" in action]
\`\`\``;
}
