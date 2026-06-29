# Deus

Multi-agent orchestrator for OpenCode with Knowledge Base, DAG engine, and auto-scaling.

17 specialized agents. SQLite + FTS5 + Memory Tree. Hybrid orchestration (LLM conductor + static pipelines).

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
| `--pipeline build-pro "task"` | Pro pipeline (researcher → architect-pro → implementer → reviewer-pro → qa) |
| `--pipeline full-cycle "task"` | Full high-stakes pipeline (researcher → architect-pro → reviewer-pro → implementer → reviewer-pro → qa → doc) |
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
│  ├── reviewer-critic (review, standard)      │
│  ├── reviewer-critic-pro (review, high-stakes)│
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
| reviewer-critic-pro | `deepseek-v4-pro` | `max` |
| All others | `deepseek-v4-flash` | `max` |

## Project Structure

Each run creates a timestamped folder in the target project:

```
.deus/
├── .gitignore              # ignores everything inside
├── kb/
│   └── orchestrator.db     # Knowledge Base (SQLite + FTS5)
└── runs/
    └── run-2026-06-29T14-20-00/
        ├── index.md         # summary with links
        ├── security-auditor.md
        ├── code-reviewer.md
        └── ...
```

## Knowledge Base

- **FTS5** — keyword search (BM25, zero dependencies)
- **Memory Tree** — hierarchical summaries (file/module/project)
- **SuperContext** — auto-context generation for tasks
- **Per-project** — each project has its own DB (`.deus/kb/orchestrator.db`)

## Smart Context Integration

Deus includes a custom tool for [Smart Context Retrieving](https://github.com/medellin17/smart-context-retrieving) — smart code search using BM25 + Symbol Graph + Graph Walk.

### Setup

```bash
# Install Smart Context in your project
cd /your/project
npm install smart-context-retrieving

# Index your project
npx code-assistant index .
```

### Usage

Agents automatically use `search_code` tool before reading or editing code:

```
search_code(query="user authentication", project="/path/to/project")
```

### What it does

- **BM25** — keyword search with synonyms
- **Symbol Graph** — parses functions/classes/types and their calls
- **Graph Walk** — 1-2 hops along call graph
- **Category Weights** — different ranking for bugfix/feature/refactor
- **Skeletonization** — compresses large files to structure + relevant chunks

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

## Related Projects

- [opencode-orchestrator](https://github.com/medellin17/opencode-orchestrator) — v1, original orchestrator that inspired Deus
- [smart-context-retrieving](https://github.com/medellin17/smart-context-retrieving) — smart code search (BM25 + Symbol Graph + Graph Walk), integrated as custom tool

## License

Apache 2.0
