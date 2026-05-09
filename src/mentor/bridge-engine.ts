import type { Archivist } from "../archivist/index.js";
import type { Reasoner } from "../connector/reasoner.js";
import type { CompressedEvent, SynapticConfig } from "../shared/types.js";
import { LANG_EXTENSIONS, extensionsForLang } from "../connector/index.js";

function buildBridgePrompt(
  error: string,
  targetLang: string,
  sourceLang: string,
  sourceSnippets: CompressedEvent[],
  concepts: string[]
): string {
  const snippetContext = sourceSnippets.length > 0
    ? sourceSnippets
        .slice(0, 3)
        .map((e, i) => `[${sourceLang} memory ${i + 1}] ${e.summary}${e.error_verbatim ? `\nError they saw: ${e.error_verbatim}` : ""}${e.resolution ? `\nHow they solved it: ${e.resolution}` : ""}`)
        .join("\n\n")
    : `No direct ${sourceLang} history found for this pattern.`;

  const conceptLine = concepts.length > 0 ? `\nKEY CONCEPTS: ${concepts.join(", ")}\n` : "";

  return `You are an Offline Mentor helping a ${sourceLang} developer learn ${targetLang}.

CURRENT ${targetLang.toUpperCase()} ERROR:
${error}
${conceptLine}
THIS DEVELOPER'S ${sourceLang.toUpperCase()} HISTORY (similar patterns they've solved before):
${snippetContext}

Your job:
1. In one sentence, name the ${sourceLang} mental model they're bringing into ${targetLang}
2. Explain why it breaks in ${targetLang} (be specific to their error)
3. Show the ${targetLang} equivalent pattern in a short code snippet
4. Reference their ${sourceLang} history if relevant — make the analogy personal

Keep it tight. Max 5 sentences + one code snippet. No fluff.`;
}

export class BridgeEngine {
  constructor(
    private archivist: Archivist,
    private reasoner: Reasoner,
    private config: SynapticConfig
  ) {}

  async explain(
    error: string,
    targetLang: string,
    concepts: string[] = [],
    imageBase64?: string
  ): Promise<AsyncGenerator<string>> {
    const sourceLang = this.config.fromLang || targetLang;

    const searchQuery = concepts.length > 0 ? concepts.join(" ") : error;

    // Filter memories to source language files when extensions are known
    const sourceExts = new Set(extensionsForLang(sourceLang).map(e => e.slice(1)));
    const sourceMemories = this.archivist
      .semanticSearch(searchQuery, 10)
      .filter((e) => {
        if (!e.file || sourceExts.size === 0) return true;
        const ext = e.file.split(".").pop()?.toLowerCase() ?? "";
        return sourceExts.has(ext);
      });

    const prompt = buildBridgePrompt(error, targetLang, sourceLang, sourceMemories, concepts);
    return this.reasoner.reasonStream(prompt, imageBase64);
  }

  // Detect language name from file extension
  static detectLang(filePath: string): string | null {
    const ext = `.${filePath.split(".").pop()?.toLowerCase() ?? ""}`;
    for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
      if (exts.includes(ext)) {
        return lang.charAt(0).toUpperCase() + lang.slice(1);
      }
    }
    return null;
  }
}
