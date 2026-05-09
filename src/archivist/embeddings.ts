/**
 * Local embedding generation for semantic search.
 *
 * Uses a lightweight approach: TF-IDF-style embeddings computed locally
 * without requiring onnxruntime. For the contest, this is sufficient.
 * In production, you'd swap in onnxruntime-node with all-MiniLM-L6-v2.
 *
 * The embedding captures: concepts, file paths, error patterns, and summary text.
 */

export class Embedder {
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private documentCount = 0;
  private readonly VECTOR_SIZE = 128;

  /**
   * Generate a simple hash-based embedding for a compressed event.
   * This uses feature hashing (the "hashing trick") to create
   * fixed-size vectors without a pre-trained model.
   */
  embed(text: string): number[] {
    const tokens = this.tokenize(text);
    const vector = new Float64Array(this.VECTOR_SIZE);

    for (const token of tokens) {
      // Hash the token to a bucket
      const hash = this.hashString(token);
      const bucket = Math.abs(hash) % this.VECTOR_SIZE;
      // Use sign of a second hash for +/- direction (reduces collision impact)
      const sign = this.hashString(token + "_sign") > 0 ? 1 : -1;
      vector[bucket] += sign;
    }

    // L2 normalize
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return Array.from(vector);
  }

  /**
   * Compute cosine similarity between two embedding vectors.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Find the top-k most similar events to a query embedding.
   */
  findSimilar(
    queryEmbedding: number[],
    candidates: Array<{ id: string; embedding: number[] }>,
    topK = 10
  ): Array<{ id: string; similarity: number }> {
    const scored = candidates
      .map((candidate) => ({
        id: candidate.id,
        similarity: this.cosineSimilarity(queryEmbedding, candidate.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, topK);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_\-./]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && token.length < 50);
  }

  private hashString(str: string): number {
    // FNV-1a hash
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) | 0;
    }
    return hash;
  }
}
