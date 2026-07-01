import { GoogleGenerativeAI } from '@google/generative-ai';

const BATCH_SIZE = 100;
const EMBEDDING_DIMENSION = 3072;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
}

export class EmbeddingService implements Embedder {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is required');
    this.genAI = new GoogleGenerativeAI(key);
    this.modelName = model ?? 'gemini-embedding-2';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const model = this.genAI.getGenerativeModel({ model: this.modelName });
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await model.batchEmbedContents({
        requests: batch.map((text) => ({
          content: { role: 'user', parts: [{ text }] },
        })),
      });
      for (const embedding of response.embeddings) {
        results.push(embedding.values);
      }
    }

    return results;
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }

  dimension(): number {
    return EMBEDDING_DIMENSION;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

let singleton: EmbeddingService | undefined;

export function getEmbeddings(): EmbeddingService {
  if (!singleton) {
    singleton = new EmbeddingService();
  }
  return singleton;
}
