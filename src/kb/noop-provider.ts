import type { KbProvider } from "./provider.js";
import type { SearchResult } from "./search.js";
import type { MemoryNode } from "./memory-tree.js";

export class NoopKbProvider implements KbProvider {
  constructor() {}

  indexFile(_path: string): void { /* no-op */ }
  indexDirectory(_path: string, _extensions?: string[]): void { /* no-op */ }
  removeFile(_path: string): void { /* no-op */ }
  search(_query: string, _limit?: number): SearchResult[] { return []; }
  getContext(_task: string, _maxTokens?: number): string { return ""; }
  hasContext(): boolean { return false; }
  upsertMemory(_path: string, _level: "file" | "module" | "project", _summary: string): void { /* no-op */ }
  getMemory(_path: string): MemoryNode | null { return null; }
  stats(): { documents: number; chunks: number; embeddings: number } { return { documents: 0, chunks: 0, embeddings: 0 }; }
  close(): void { /* no-op */ }
}
