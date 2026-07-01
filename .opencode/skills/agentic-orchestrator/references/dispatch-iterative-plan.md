# Dispatch Template: Iterative Plan

Multi-pass plan refinement with parallel review loop.

## When to Use
- Complex or high-risk tasks
- Plan needs validation from multiple angles (correctness, security, code quality)
- Standard plan-review cycle isn't thorough enough

## Process

### Iteration 1
1. Dispatch `architect-planner` to create initial plan
2. In parallel, dispatch:
   - `reviewer-critic` — correctness + completeness
   - `security-auditor` — security risks
   - `code-reviewer` — code quality + maintainability
3. Collect all 3 reviews
4. If no critical issues → proceed to sign-off
5. If issues found → dispatch `architect-planner` with all 3 reviews as context

### Iteration 2
6. Architect produces refined plan
7. Dispatch `reviewer-critic` for final sign-off
8. If issues remain → escalate to user
9. If clean → APPROVED

### Max Iterations
2 iterations. If unresolved on 2nd pass, escalate to user with all review reports.
