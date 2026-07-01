import { openKB, type KBDatabase } from "./schema.js";
import { FTS5Index, type FTS5Result } from "./fts5.js";
import { MemoryTree, type MemoryNode } from "./memory-tree.js";
import { HybridSearch, type SearchResult } from "./search.js";
import { SuperContext } from "./super-context.js";
import { KBIndexer } from "./indexer.js";
import { getEmbeddings } from "./embeddings.js";
import type { Embedder } from "./embeddings.js";
import type { KbProvider } from "./provider.js";

export class RagKbProvider implements KbProvider {
  private fts5: FTS5Index;
  private memoryTree: MemoryTree;
  private hybridSearch: HybridSearch;
  private superContext: SuperContext;
  private indexer: KBIndexer;
  private embedder?: Embedder;
  public db: KBDatabase;

  constructor(dbPath?: string) {
    this.db = openKB(dbPath);
    const raw = this.db.raw;

    if (process.env.GEMINI_API_KEY) {
      try {
        this.embedder = getEmbeddings();
      } catch {
        // Embeddings unavailable, proceed without
      }
    }

    this.fts5 = new FTS5Index(raw);
    this.memoryTree = new MemoryTree(raw);
    this.hybridSearch = new HybridSearch(raw, this.embedder);
    this.superContext = new SuperContext(raw);
    this.indexer = new KBIndexer(raw, this.embedder);
  }

  indexFile(path: string): void {
    this.indexer.indexFile(path);
  }

  indexDirectory(path: string, extensions?: string[]): void {
    this.indexer.indexDirectory(path, extensions);
  }

  removeFile(path: string): void {
    this.indexer.removeFile(path);
  }

  search(query: string, limit?: number): SearchResult[] {
    return this.hybridSearch.search(query, limit);
  }

  getContext(task: string, maxTokens?: number): string {
    return this.superContext.getContext(task, maxTokens);
  }

  hasContext(): boolean {
    return this.superContext.hasContext();
  }

  upsertMemory(path: string, level: "file" | "module" | "project", summary: string): void {
    this.memoryTree.upsert(path, level, summary);
  }

  getMemory(path: string): MemoryNode | null {
    return this.memoryTree.get(path);
  }

  stats() {
    return this.indexer.stats();
  }

  async generateEmbeddings(): Promise<number> {
    if (!this.embedder) {
      console.log("[KB] Эмбеддинги не доступны (нет GEMINI_API_KEY)");
      return 0;
    }
    const count = await this.indexer.generateEmbeddings();
    if (count > 0) {
      console.log(`[KB] Сгенерировано эмбеддингов: ${count}`);
    }
    return count;
  }

  async semanticSearch(query: string, limit?: number): Promise<SearchResult[]> {
    if (!this.embedder) return [];
    return await this.hybridSearch.semanticSearch(query, limit);
  }

  close(): void {
    this.db.close();
  }
}
