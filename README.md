# Deus

Two runners live in this repo:

- **Current — V2-native deterministic runner:** [`src/v2`](src/v2/README.md), for OpenCode 2.x. This is the one to use.
- **Legacy — V1 orchestrator:** `src/orchestrator.ts`, the original multi-agent orchestrator (18 agents, Knowledge Base, DAG engine, auto-scaling). It uses the V1 SDK (`@opencode-ai/sdk`), targets OpenCode 1.x, and is not compatible with the V2 server API. Kept as a reference.

Everything below the "V2 runner" section describes the legacy V1 orchestrator.

## V2 runner (recommended for OpenCode 2.x)

```bash
npm install
npm run v2:smoke
npm run v2 -- --cwd /path/to/project --pipeline build "your task"
```

It runs deterministic pipelines (`build`, `fix`, `audit`), uses the shared OpenCode V2 service,
answers permission requests by policy, checkpoints every step, and runs in a git worktree by default.
Steps that change code are verified by project checks (`deus.json`) and retried with the failure
output; a successful run is committed and merged with `--no-ff` when the project is on the same
clean branch. A red baseline is compared by failing test names, so pre-existing failures do not
block a run. Merge conflicts are resolved by the `build` agent, verified by checks, and committed;
otherwise the `deus/run-*` branch is left for manual merge. `--pipeline auto` asks an LLM planner
for a validated step list, `--plan-only` shows it before running.
See [`src/v2/README.md`](src/v2/README.md) for details, config, resume, and safety rules.

## Legacy V1 quick start

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
| `--orchestrate "task"` | Same as above, explicit mode |
| `--pipeline build "task"` | Static pipeline (researcher → architect → implementer → reviewer → qa) |
| `--pipeline build-pro "task"` | Pro pipeline (researcher → architect-pro → implementer → reviewer-pro → qa) |
| `--pipeline full-cycle "task"` | Full high-stakes pipeline (researcher → architect-pro → reviewer-pro → implementer → reviewer-pro → qa → doc) |
| `--agent implementer-builder "task"` | Single agent |
| `--parallel "task1" "task2"` | Parallel execution |
| `--dag graph.json` | Execute a DAG graph |
| `--sub-orch domains.json` | Run parallel sub-orchestrators |
| `--resume [checkpointId]` | Resume from checkpoint |
| `--index /path/to/project` | Manual KB indexing |
| `--kb-stats` | Knowledge Base statistics |
| `--metrics` | Show orchestrator-monitor plugin metrics |
| `--no-rag` | Disable Knowledge Base context injection |
| `--max-depth <n>` | Max parallel sub-orchestrator domains |
| `--output-dir, -o <name>` | Custom run folder name in `.deus/runs/` |

## Architecture

```
orchestrator.ts (CLI + SDK)
    ↓
opencode serve (HTTP API, port 4096)
    ↓
┌─────────────────────────────────────────────────────────────┐
│  18 agents (17 + sub-orchestrator)                          │
│  ├── orchestrator-conductor (LLM conductor)                 │
│  ├── researcher-explorer (research)                         │
│  ├── architect-planner / architect-planner-pro (planning)   │
│  ├── implementer-builder (implementation)                   │
│  ├── reviewer-critic / reviewer-critic-pro (review)         │
│  ├── integrator-qa (testing)                                │
│  └── 11 other specialized agents                            │
└─────────────────────────────────────────────────────────────┘
    ↓
Knowledge Base + State (SQLite)
    ├── Auto-indexing
    ├── Context injection before planning
    ├── Memory Tree across sessions
    ├── Checkpoints / auto-resume
    └── DAG / sub-orchestrator state
```

## Project Structure

Each run creates a timestamped folder in the target project:

```
.deus/
├── .gitignore              # ignores everything inside
├── kb/
│   ├── orchestrator.db     # Knowledge Base + State DB (SQLite + FTS5)
│   └── metrics.db          # Monitor plugin metrics
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

## State, DAG & Checkpoints

- **State DB** — SQLite-таблицы `tasks`, `task_nodes`, `session_log`, `agent_stats` для DAG-исполнения и аналитики.
- **DAG** — выполняйте произвольные графы зависимых агентов через `--dag graph.json` (`src/dag/engine.ts`).
- **Checkpoints** — при переполнении контекста (>140k токенов) оркестратор сохраняет состояние и автоматически делает до 5 попыток resume.

Подробнее об агентах, пайплайнах, KB и архитектуре: [AGENTS.md](./AGENTS.md), [ARCHITECTURE.md](./ARCHITECTURE.md).

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
