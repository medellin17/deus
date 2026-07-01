# Sub-Agents (Deus v2)

| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| `orchestrator-conductor` | Plans, delegates, synthesizes. No execution. | `task`, `skill` | pro |
| `researcher-explorer` | Read-only exploration. Maps code, data, content. | `read`, `grep`, `glob`, `webfetch` | flash |
| `architect-planner` | Design & strategy (simple). | `read`, `grep` | flash |
| `architect-planner-pro` | Design & strategy (complex/high-stakes). | `read`, `grep` | pro |
| `implementer-builder` | Writes code, configs, scripts. | `read`, `edit`, `write`, `bash` | flash |
| `reviewer-critic` | Audit & review (standard). | `read`, `grep` | flash |
| `reviewer-critic-pro` | Audit & review (high-stakes). | `read`, `grep` | pro |
| `integrator-qa` | Runs tests, validates alignment. | `read`, `bash` | flash |
| `content-writer` | Writing & copywriting. | `read`, `write`, `edit` | flash |
| `data-analyst` | Analysis & processing. | `read`, `write`, `bash` | flash |
| `ux-designer` | UX/UI design. | `read`, `write`, `edit` | flash |
| `debug` | Root-cause diagnostics. | `read`, `edit`, `write`, `bash` | flash |
| `code-reviewer` | Structured code review (5 dimensions). | `read`, `grep` | flash |
| `test-engineer` | Test generation. | `read`, `write`, `edit`, `bash` | flash |
| `security-auditor` | Security scanning. | `read`, `grep`, `bash` | flash |
| `doc-maintainer` | Documentation updates. | `read`, `write`, `edit`, `glob`, `bash` | flash |
| `skills-indexer` | Skills discovery and indexing. | `read`, `write`, `glob`, `bash` | flash |
