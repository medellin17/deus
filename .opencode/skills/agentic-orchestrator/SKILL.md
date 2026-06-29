---
name: agentic-orchestrator
description: Universal multi-agent orchestration skill for OpenCode. Enables a primary conductor agent to decompose any complex task, select execution pipelines, dispatch work to specialized sub-agents, and synthesize final reports. Use when the user requests multi-step workflows, wants to run a team of agents, says "orchestrate this", "run agents", "use a pipeline", or needs plan-create-review cycles.
---

# Agentic Orchestrator

Multi-agent execution engine. A **conductor agent** (`orchestrator-conductor`) selects a pipeline, dispatches sub-agents via `task()`, and synthesizes the result. Sub-agents never call each other directly.

## Models

| Agent | Model | Thinking |
|-------|-------|----------|
| orchestrator-conductor | `opencode-go/deepseek-v4-pro` | `reasoningEffort: "max"` |
| architect-planner-pro | `opencode-go/deepseek-v4-pro` | `reasoningEffort: "max"` |
| All other agents | `opencode-go/deepseek-v4-flash` | `reasoningEffort: "max"` |

## Architecture

```
User Task
    ↓
Conductor (orchestrator-conductor)
    ├── researcher-explorer   (read-only investigation)
    ├── architect-planner*    (design & strategy)
    ├── [spot-check]          (read/grep verification)
    ├── implementer-builder   (execution)
    ├── [spot-check]          (read/grep verification)
    ├── reviewer-critic       (audit & validation)
    ├── integrator-qa         (testing)
    └── Final Synthesis Report
```

## Sub-Agents (16)

| Agent | Role | Tools |
|-------|------|-------|
| `orchestrator-conductor` | Plans, delegates, spot-checks, synthesizes | `task`, `skill`, `read`, `grep` |
| `researcher-explorer` | Read-only exploration, code mapping | `read`, `grep`, `glob`, `webfetch` |
| `architect-planner` | Design & strategy (simple) | `read`, `grep` |
| `architect-planner-pro` | Design & strategy (complex/high-stakes) | `read`, `grep` |
| `implementer-builder` | Writes code, configs, scripts | `read`, `edit`, `write`, `bash` |
| `reviewer-critic` | Audit & review | `read`, `grep` |
| `integrator-qa` | Runs tests, validates | `read`, `bash` |
| `content-writer` | Writing & copywriting | `read`, `write`, `edit` |
| `data-analyst` | Analysis & processing | `read`, `write`, `bash` |
| `ux-designer` | UX/UI design | `read`, `write`, `edit` |
| `debug` | Root-cause diagnostics | `read`, `edit`, `write`, `bash` |
| `code-reviewer` | Structured code review | `read`, `grep` |
| `test-engineer` | Test generation | `read`, `write`, `edit`, `bash` |
| `security-auditor` | Security scanning | `read`, `grep`, `bash` |
| `doc-maintainer` | Documentation updates | `read`, `write`, `edit`, `glob`, `bash` |
| `skills-indexer` | Skills discovery | `read`, `write`, `glob`, `bash` |

## Pipelines

### Static (orchestrator.ts)

| Name | Steps |
|------|-------|
| `build` | researcher → architect → implementer → reviewer → qa |
| `build-pro` | researcher → architect-pro → implementer → reviewer → qa |
| `audit` | security → code-reviewer → reviewer |
| `debug` | researcher → debug → implementer → qa |
| `docs` | researcher → content-writer → reviewer |

### Dynamic (conductor selects)

The conductor picks the best pipeline based on task complexity:

| Complexity | Pipeline | Agents |
|------------|----------|--------|
| Trivial (1 file) | direct | `implementer-builder` |
| Simple (2-3 files) | build | researcher → architect → qa |
| Standard (multi-file) | build-review | researcher → architect → reviewer → implementer → reviewer → qa |
| High-stakes | full-cycle | build-review → doc-maintainer |
| Bug fix | debug-fix | researcher → architect → debug → implementer → qa |
| Audit | parallel-audit | reviewer ∥ security → synthesize |
| Research | parallel-research | researcher₁ ∥ researcher₂ ∥ ... → synthesize |

## Dispatch Protocol

```
task({
  description: "Short task label",
  prompt: "You are [agent-role].\n\nGoal: [...]\n\nContext:\n[paste exact outputs from previous steps]\n\nDeliverable: [format]\n\nConstraints: [what NOT to do]",
  subagent_type: "[agent_type_name]"
})
```

### Rules

1. **Never execute yourself.** Delegate to sub-agents.
2. **Spot-check first.** After implementer/architect, read files to verify. If issues found → dispatch fix directly.
3. **Full review via sub-agents.** For comprehensive review/security/QA → dispatch reviewer.
4. **Split by default.** One agent = one responsibility. Merge only for trivial tasks.
5. **Research first.** Always dispatch researcher-explorer before planning.
6. **Full context always.** Copy-paste previous outputs into each task() call. Sub-agents are stateless.
7. **Explicit deliverables.** Name output format and save location.
8. **Retry limit.** Max 3 iterations before escalating to user.
9. **Announce pipeline.** First message: pipeline name + stage list.
10. **Synthesize, don't dump.** Final report is concise and actionable.

## Conditional Loops

If reviewer rejects or QA fails:
1. Capture feedback verbatim
2. Route back to upstream agent
3. Include feedback as context
4. Max 3 iterations → escalate to user

## Knowledge Base Integration

The orchestrator uses a Knowledge Base (SQLite + FTS5) for context between sessions:
- Auto-indexes project on first run
- Injects relevant context before planning
- Saves task results to memory tree
- Per-project isolation (`.deus/kb/orchestrator.db`)
