import { openKB, type KBDatabase } from "./schema.js";
import { FTS5Index, type FTS5Result } from "./fts5.js";
import { MemoryTree, type MemoryNode } from "./memory-tree.js";
import { HybridSearch, type SearchResult } from "./search.js";
import { SuperContext } from "./super-context.js";
import { KBIndexer } from "./indexer.js";

export class KnowledgeBase {
  private fts5: FTS5Index;
  private memoryTree: MemoryTree;
  private hybridSearch: HybridSearch;
  private superContext: SuperContext;
  private indexer: KBIndexer;
  public db: KBDatabase;

  constructor(dbPath?: string) {
    this.db = openKB(dbPath);
    const raw = this.db.raw;
    this.fts5 = new FTS5Index(raw);
    this.memoryTree = new MemoryTree(raw);
    this.hybridSearch = new HybridSearch(raw);
    this.superContext = new SuperContext(raw);
    this.indexer = new KBIndexer(raw);
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

  close(): void {
    this.db.close();
  }
}

export function createKB(dbPath?: string): KnowledgeBase {
  return new KnowledgeBase(dbPath);
}

export type { FTS5Result } from "./fts5.js";
export type { SearchResult } from "./search.js";
export type { MemoryNode } from "./memory-tree.js";
export type { Chunk, Document, Embedding, KBDatabase } from "./schema.js";
export { cosineSimilarity } from "./embeddings.js";
