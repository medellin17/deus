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
| `--metrics` | Show orchestrator-monitor plugin metrics |

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

Встроенная Knowledge Base на SQLite + FTS5 с гибридным поиском (BM25 + Memory Tree + опциональные эмбеддинги Gemini).
Индексация проекта происходит автоматически при первом запуске. Контекст инжектится перед планированием.

Подробнее об агентах, пайплайнах и KB: [AGENTS.md](./AGENTS.md).

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
- [AGENTS.md](./AGENTS.md) — полное описание агентов, пайплайнов и KB

## License

Apache 2.0
