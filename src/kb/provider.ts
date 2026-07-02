import type { SearchResult } from "./search.js";
import type { MemoryNode } from "./memory-tree.js";

export interface KbProvider {
  indexFile(path: string): void;
  indexDirectory(path: string, extensions?: string[]): void;
  removeFile(path: string): void;
  search(query: string, limit?: number): SearchResult[];
  searchCode(query: string, topN?: number): string;
  getContext(task: string, maxTokens?: number, topK?: number): string;
  hasContext(): boolean;
  upsertMemory(path: string, level: "file" | "section" | "project" | "checkpoint", summary: string): void;
  getMemory(path: string): MemoryNode | null;
  stats(): { documents: number; chunks: number; embeddings: number };
  close(): void;
}
