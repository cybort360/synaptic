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

Respond with your insights. Be direct and specific.`;
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

export function buildMentalMapPrompt(
  newConcept: string,
  knownConcepts: string[],
  lang: LangCtx = null
): string {
  const langContext = lang?.from && lang?.to
    ? `The developer is coming from ${lang.from} and learning ${lang.to}. Frame your mappings in terms of ${lang.from} concepts they already know.`
    : "Frame mappings in terms of concepts the developer already knows.";

  return `You are Synaptic, a developer's second brain. Map a new concept to things the developer already understands.

${langContext}

NEW CONCEPT:
${newConcept}

CONCEPTS THE DEVELOPER KNOWS:
${knownConcepts.slice(0, 30).join(", ")}

For each relevant mapping:
- Name the known concept it maps to
- Explain what's the same and what's different
- Give a one-line code comparison if applicable

Only map to concepts you're confident about. Skip tenuous analogies. Be concise.`;
}
