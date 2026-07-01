import type { SearchResult } from "./search.js";
import type { MemoryNode } from "./memory-tree.js";

export interface KbProvider {
  indexFile(path: string): void;
  indexDirectory(path: string, extensions?: string[]): void;
  removeFile(path: string): void;
  search(query: string, limit?: number): SearchResult[];
  getContext(task: string, maxTokens?: number): string;
  hasContext(): boolean;
  upsertMemory(path: string, level: "file" | "module" | "project", summary: string): void;
  getMemory(path: string): MemoryNode | null;
  stats(): { documents: number; chunks: number; embeddings: number };
  close(): void;
}
