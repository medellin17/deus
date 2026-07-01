export type { KbProvider } from "./provider.js";
export { RagKbProvider } from "./rag-provider.js";
export { NoopKbProvider } from "./noop-provider.js";

import { RagKbProvider } from "./rag-provider.js";
import { NoopKbProvider } from "./noop-provider.js";
import type { KbProvider } from "./provider.js";

export { CheckpointManager } from "./checkpoint.js";
export type { CheckpointState, CompletedDispatch, PendingDispatch } from "./checkpoint.js";

/** @deprecated Use KbProvider type instead */
export type KnowledgeBase = KbProvider;

export function createKB(dbPath?: string, useRag?: boolean): KbProvider {
  const rag = useRag ?? true;
  return rag ? new RagKbProvider(dbPath) : new NoopKbProvider();
}

// Preserve all existing re-exports:
export type { FTS5Result } from "./fts5.js";
export type { SearchResult } from "./search.js";
export type { MemoryNode } from "./memory-tree.js";
export type { Chunk, Document, Embedding, KBDatabase } from "./schema.js";
export { cosineSimilarity } from "./embeddings.js";
