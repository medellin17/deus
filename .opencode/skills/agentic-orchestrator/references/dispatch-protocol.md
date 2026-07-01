# Dispatch Protocol (Deus v2)

## The Task Template
```
task({
  description: "Short label (3-7 words)",
  prompt: `You are [agent-role].

## Goal
[One sentence + COMPLETION CRITERION]

## Context
[Copy-paste ALL relevant artifacts. Sub-agents have no shared memory.]

## Deliverable
[Format + file path. Be specific.]

## Constraints
[What NOT to do. Domain rules.]`,
  subagent_type: "agent-type-name"
})
```

## Completion Criteria

| Weak | Strong |
|------|--------|
| "Review the code" | "Return VERIFIED or ISSUES_FOUND with line references" |
| "Research the codebase" | "Return structured findings saved to data/tasks/<name>/research.md" |
| "Implement the feature" | "Return with files created, tests passing, deviation log" |

## Context Brief (for architect-planner-pro)

Structure: User Goal → Scope → Constraints → Key Files → Existing Patterns → Risks → Research.

## Weak Model Mindset (deepseek-v4-flash)
- Over-explain. Spell out edge cases.
- One task per dispatch.
- Numbered checklists for 3+ steps.
- Validate format explicitly ("Output ONLY valid JSON").
- Extract relevant 50 lines, not 2000.
- Request risk_areas and confidence from implementers.

## Parallel Dispatch
- Launch independent `task()` calls in the same message.
- Collect all results before proceeding.
- Never parallelize: architect-planner-pro, ordered phases.
