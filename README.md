# Deus

Multi-agent orchestrator for OpenCode with Knowledge Base, DAG engine, and auto-scaling.

16 specialized agents. SQLite + FTS5 + Memory Tree. Hybrid orchestration (LLM conductor + static pipelines).

## Quick Start

```bash
git clone https://github.com/medellin17/deus.git
cd deus
npm install
npx tsx src/orchestrator.ts --cwd /path/to/project "your task"
```

On first run, Deus automatically:
- Copies `.opencode/` (agents + config) to the target project
- Spawns `opencode serve` in the target directory
- Indexes the project into Knowledge Base
- Injects context before planning

## Modes

| Command | What it does |
|---------|-------------|
| `npx tsx src/orchestrator.ts "task"` | LLM conductor picks pipeline and dispatches agents |
| `--pipeline build "task"` | Static pipeline (researcher → architect → implementer → reviewer → qa) |
| `--agent implementer-builder "task"` | Single agent |
| `--parallel "task1" "task2"` | Parallel execution |
| `--index /path/to/project` | Manual KB indexing |
| `--kb-stats` | Knowledge Base statistics |

## Architecture

```
orchestrator.ts (CLI + SDK)
    ↓
opencode serve (HTTP API, port 4096)
    ↓
┌─────────────────────────────────────────────┐
│  Conductor (orchestrator-conductor)         │
│  ├── researcher-explorer (research)         │
│  ├── architect-planner* (planning)          │
│  ├── implementer-builder (implementation)   │
│  ├── reviewer-critic (review)               │
│  ├── integrator-qa (testing)                │
│  └── 11 other agents                        │
└─────────────────────────────────────────────┘
    ↓
Knowledge Base (SQLite + FTS5)
    ├── Auto-indexing
    ├── Context injection before planning
    └── Memory across sessions
```

## Models

| Agent | Model | Thinking |
|-------|-------|----------|
| orchestrator-conductor | `deepseek-v4-pro` | `max` |
| architect-planner-pro | `deepseek-v4-pro` | `max` |
| All others | `deepseek-v4-flash` | `max` |

## Knowledge Base

- **FTS5** — keyword search (BM25, zero dependencies)
- **Memory Tree** — hierarchical summaries (file/module/project)
- **SuperContext** — auto-context generation for tasks
- **Per-project** — each project has its own DB (`.agents/orchestrator.db`)

### Tables

| Table | Purpose |
|-------|---------|
| `kb_documents` | Indexed files |
| `kb_chunks` | Semantic chunks |
| `kb_chunks_fts` | FTS5 index |
| `kb_embeddings` | Vector embeddings |
| `kb_memory_tree` | Hierarchical summaries |

## Environment

| Variable | Purpose |
|----------|---------|
| `OPENCODE_URL` | Server URL (default: `http://localhost:4096`) |
| `GEMINI_API_KEY` | Gemini embeddings key (optional, for RAG) |

## Adding an Agent

1. Create `.opencode/agents/{name}.md`
2. Add to `VALID_AGENTS` in `src/orchestrator.ts`
3. Add to `.opencode/opencode.json` (if custom model needed)

## Requirements

- Node.js 20+
- OpenCode CLI (`npm i -g opencode`)
- `GEMINI_API_KEY` (optional, for embeddings)

## License

Apache 2.0
