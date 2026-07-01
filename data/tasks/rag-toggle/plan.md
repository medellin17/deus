# RAG Toggle Implementation Plan

## Goal
Add a clean RAG on/off toggle to the Knowledge Base system using Strategy Pattern + CLI flag `--rag`/`--no-rag`.

When RAG is OFF: all KB operations become no-ops (return empty results).
When RAG is ON: current full functionality preserved (default).

## Files to Create
1. `src/kb/provider.ts` — KbProvider interface
2. `src/kb/noop-provider.ts` — NoopKbProvider (all no-ops)
3. `src/kb/rag-provider.ts` — RagKbProvider (extracted from KB class)

## Files to Modify
4. `src/kb/index.ts` — Replace class with factory + re-exports
5. `src/orchestrator.ts` — Add --rag/--no-rag CLI flags, wire up toggle

## Stage 1: Create `src/kb/provider.ts`
Interface defining the contract for all KB providers.

## Stage 2: Create `src/kb/noop-provider.ts`
All methods no-op, returns empty/false/null values.

## Stage 3: Create `src/kb/rag-provider.ts`
Extract KnowledgeBase class from kb/index.ts, rename to RagKbProvider, add `implements KbProvider`.

## Stage 4: Rewrite `src/kb/index.ts`
Remove the class, keep re-exports, add factory function `createKB(dbPath?, useRag?)`.

## Stage 5: Update `src/orchestrator.ts`
- Add `--rag`/`--no-rag` flags to parseArgs
- Pass `useRag` through to getKB() and createKB()
- Propagate globalUseRag to all getKB() calls
- Add flag descriptions to printHelp()
