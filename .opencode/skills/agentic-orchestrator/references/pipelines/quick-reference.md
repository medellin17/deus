# Pipeline Quick Reference (Deus v2)

## Selection Table

| Condition | Pipeline | Sequence |
|-----------|----------|----------|
| Trivial (1 file, 1 fix) | direct | implementer-builder or debug |
| Simple (2-3 files, no new arch) | build | researcher → architect-planner* → integrator-qa |
| Standard (multi-file, new feature) | build-review | researcher → architect-planner* → reviewer-critic* → implementer → reviewer-critic* → integrator-qa |
| Medium, good for ensemble | build-ensemble | researcher → planner₁ ∥ planner₂ → reviewer₁ ∥ reviewer₂ → synthesis → implementer → reviewer₁ ∥ reviewer₂ → synthesis → qa |
| High-stakes (auth, payments, data loss) | full-cycle | researcher → architect-planner-pro → reviewer-critic-pro → implementer → reviewer-critic-pro → integrator-qa → doc-maintainer |
| Bug fix (unknown root) | debug-fix | researcher → architect-planner* → debug → implementer → integrator-qa |
| Audit / assessment | parallel-audit | reviewer-critic ∥ security-auditor → synthesize |
| Deep research | parallel-research | researcher₁ ∥ researcher₂ ∥ researcher₃ → synthesize |
| Multi-angle review | parallel-review | reviewer-critic ∥ security-auditor ∥ code-reviewer → synthesize |
| Content / docs | content | researcher → content-writer → reviewer-critic* |
| Data analysis | data | researcher → data-analyst → reviewer-critic* → integrator-qa |
| Design / UX | design | researcher → ux-designer → reviewer-critic* → implementer (prototype) |
| Planning | plan | researcher → architect-planner* |
| Research | research | researcher-explorer |

Auto-doc: append `→ doc-maintainer` when architecture/APIs change.

## Static Pipelines (orchestrator.ts CLI)
Available via `--pipeline` flag: build, build-pro, full-cycle, audit, debug, docs, parallel-audit, parallel-research, parallel-review, content, data, design, plan, research.

## Completion Criteria

| Pipeline | Criterion |
|----------|-----------|
| research | All relevant files read. Findings saved to `data/tasks/<name>/research.md`. |
| build-review | Tests pass. Implementation matches plan. Reviewer: VERIFIED or ISSUES_FOUND. |
| full-cycle | Tests pass. Pro-reviewer approved. Docs updated. |
| debug-fix | Bug reproduced in tight loop. Fix applied. Regression test passes. |
| parallel-* | All parallel outputs collected. Synthesis resolves conflicts. |
