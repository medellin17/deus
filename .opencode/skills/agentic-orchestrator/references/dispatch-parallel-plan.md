# Dispatch Template: Parallel Plan

For divergent design proposals — launching two `architect-planner` agents with different angles in parallel.

## When to Use
- Medium complexity, need divergent solutions
- Want to explore different architectural approaches
- Conductor will select/merge the best approach from both

## Task Template

Dispatch both planners in the same message:

```
// Architect 1 — conservative approach
task({
  description: "Plan: conservative architecture",
  prompt: `You are architect-planner.

Goal: Design an architecture for [task] using the MOST proven, mature patterns.

Context: [full context]

Constraints:
- Prefer well-known libraries and patterns
- Minimize new dependencies
- Maximize maintainability over performance

Deliverable: Technical plan saved to data/tasks/<name>/plan-conservative.md`,
  subagent_type: "architect-planner"
})

// Architect 2 — innovative approach
task({
  description: "Plan: innovative architecture",
  prompt: `You are architect-planner.

Goal: Design an architecture for [task] using the MOST modern, efficient patterns.

Context: [full context]

Constraints:
- Optimize for performance and DX
- Consider new libraries/patterns
- Maximize developer experience

Deliverable: Technical plan saved to data/tasks/<name>/plan-innovative.md`,
  subagent_type: "architect-planner"
})
```

## After Both Complete

1. Read both plans (beginning only — headings + key decisions)
2. Compare approaches
3. Select or merge into a single plan
4. Present decision to user with reasoning
