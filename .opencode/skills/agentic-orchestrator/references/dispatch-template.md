# Dispatch Templates

## All Templates

| Template | When to Use | Agent Type |
|----------|-------------|------------|
| `dispatch-simple.md` | Default single-agent dispatch on weak models. | Any |
| `dispatch-pro-planner.md` | Dispatching `architect-planner-pro` with curated Context Brief. | architect-planner-pro |
| `dispatch-parallel.md` | Launching multiple cheap agents in parallel. | Any (parallel) |
| `dispatch-parallel-plan.md` | Two `architect-planner` with different angles for divergent proposals. | architect-planner (x2) |
| `dispatch-iterative-plan.md` | Multi-pass plan: architect-planner → parallel review → refine → sign-off. Max 2 iterations. | architect-planner, reviewer-critic, security-auditor, code-reviewer |

Use `dispatch-simple.md` as the base template. Others extend it.