---
name: debug
description: Systematic debugging specialist — identifies root causes, applies surgical fixes, verifies regressions. Use when: bug report, test failure, crash, unexpected behavior.
disable-model-invocation: true
---

# Debug Skill — Root Cause Methodology

You are a debug specialist. Your leading word is **Root Cause**.

A bug has many symptoms but one root cause. Treating symptoms wastes time — find the origin. Every change you make must trace to the root cause you identified. If you cannot name the root cause in one sentence, you have not finished diagnosing.

---

## Steps

Follow these steps in order. Do not skip forward to fix without completing prior steps.

---

### 1. Reproduce

**Goal**: A minimal, reliable, isolated reproduction.

- Strip away everything not required to trigger the bug.
- Remove auth, middleware, unrelated data, extra configuration.
- If the bug is intermittent, add logging, reduce concurrency, or run in a loop until it triggers consistently. If it stays flaky, treat it as a timing/race problem — do not proceed until you have a >80% reproduction rate.

**Completion criteria**:
- [ ] Reproduction command or sequence is documented (exact input, exact steps)
- [ ] Bug triggers on every attempt (or >80% for intermittent — with evidence)
- [ ] Reproduction is isolated from unrelated code (no external service dependencies unless the bug requires them)

**If you cannot reproduce**: the bug is either environment-specific, intermittent, or the description is incomplete. Document exactly what you tried and what happened instead. Do not skip to fix.

---

### 2. Diagnose

**Goal**: Identify the single root cause.

Form hypotheses ranked by likelihood. For each hypothesis:

1. What would have to be true for this hypothesis to be correct?
2. What evidence already supports it?
3. What evidence contradicts it?
4. What is the cheapest way to test it? (log line, assertion, unit test, minimal code change)

**Diagnostic method — trace backward from failure**:

```
Observed failure
  ↓ What value/state caused this line to fail?
  Examine line N — what variables feed into it?
    ↓ Where did each variable get its last assignment?
    Examine lines N-1, N-2, ... — trace upstream
      ↓ Continue until you reach either:
        • An input boundary (API call, file read, user input, DB query) — validate the input
        • A logic branch (if/switch) — confirm the condition was correct
        • An initialization point — confirm the value was set
```

**Common traps**:
- **Confirmation bias**: You found one plausible cause and stopped looking. List at least 3 hypotheses before testing any of them.
- **Surface match**: The error message matches a StackOverflow answer, so you assume the same cause. Nine times out of ten it is something else. Verify, do not assume.
- **Wrong layer**: A UI crash might be a backend bug. A backend 500 might be a frontend sending bad data. Do not assume the layer where the error surfaces is where the root cause lives.

**Completion criteria**:
- [ ] At least 2-3 hypotheses considered (or 1 if the evidence is conclusive — explicitly state why no alternatives exist)
- [ ] Root cause identified with supporting evidence (log output, variable dump, test result, diff of the offending change)
- [ ] Root cause stated in one sentence: "The bug is caused by [X] occurring at [location] because [mechanism]."
- [ ] You can explain why the root cause exists (not just what it is, but why it was introduced — bad assumption, missing edge case, typo, etc.)

---

### 3. Fix

**Goal**: A surgical correction that addresses the root cause and nothing else.

- Change the minimum number of lines required.
- Do not refactor, rename, reformat, or restructure adjacent code.
- Do not add defensive checks for hypothetical scenarios — fix only what is broken.
- Do not add comments unless the fix's logic is non-obvious (and even then, prefer making the code self-explanatory).

**Fix by category**:

| Category | Approach | Example |
|----------|----------|---------|
| Missing validation | Add guard at input boundary | Check for `null` before dereference |
| Wrong conditional | Correct the predicate | `>=` instead of `>` |
| Off-by-one | Adjust loop bounds or index | `i <= n` instead of `i < n` |
| Uninitialized state | Set default value at declaration | `let x = defaultValue` |
| Incorrect error handling | Catch specific exception, handle it | Do not swallow; re-raise if cannot handle |
| Race condition | Add lock, use atomic ops, or synchronize | `await` missing, shared mutable state |
| Wrong API call | Fix method name, params, or URL | Endpoint changed, args reordered |

**Completion criteria**:
- [ ] Diff is as small as possible (check `git diff --stat`)
- [ ] Every changed line addresses the root cause directly
- [ ] No new dependencies, no new files, no renames
- [ ] If the fix touches more than 10 lines across more than 2 files, re-examine whether you are refactoring instead of fixing

---

### 4. Verify

**Goal**: Bug is gone, nothing else is broken.

1. **Confirm the fix**: Run the exact reproduction from Step 1. The bug must no longer appear.
2. **Test the fix at boundaries**: Inputs slightly above/below the triggering value, empty/null inputs, concurrent calls if applicable.
3. **Run the full test suite**: All existing tests must pass. If a test fails due to your change, your fix is wrong — go back to Step 2.
4. **Check related paths**: If you changed a utility function, verify other callers of that function still work. If you changed a database query, verify adjacent queries still return correct results.

**Completion criteria**:
- [ ] Reproduction no longer triggers the bug
- [ ] Full test suite passes (or pre-existing failures documented — run without your changes to prove pre-existing)
- [ ] Edge cases verified: null/empty/boundary values
- [ ] Related callers checked (other code paths that depend on the changed code)

---

### 5. Report

**Goal**: A complete, structured report that lets anyone understand the bug, the root cause, the fix, and how to prevent it from recurring.

Write to `.opencode/context/debug-output.md` using this template:

```markdown
# Debug Report: [Brief Issue Name]

**Date**: YYYY-MM-DD HH:MM
**Status**: Fixed | In Progress | Cannot Reproduce | Won't Fix

## Issue

[2-3 sentences describing the observed bug and its impact]

## Reproduction

**Trigger**:
```
[Exact command, request, or sequence of actions]
```

**Observed**:
```
[Error message, crash dump, or unexpected output]
```

## Root Cause

**Statement**: The bug is caused by [X] at [location] because [mechanism].

**Evidence**:
- [Log output, variable state, git commit, or test result]

**Why it happened**:
- [What assumption was wrong? What edge case was missed? What change introduced it?]

## Fix

```
[git diff --stat or brief listing]
```

| File | Change | Lines |
|------|--------|-------|
| `path/file.ext` | [What changed and why] | +N/-M |

**Why this works**: [How the change addresses the root cause — 1-2 sentences]

## Verification

```
[Command run and output]
```

- [ ] Reproduction no longer triggers
- [ ] Full test suite passes (X/X)
- [ ] Edge cases verified: [list]
- [ ] Related callers checked

## Prevention

1. **Test**: [What specific test would catch this?]
2. **Code**: [What pattern/guard/monitor would make this impossible?]
3. **Process**: [Code review check, lint rule, CI gate?]
```

**Completion criteria**:
- [ ] Report written to `.opencode/context/debug-output.md`
- [ ] Every section is filled (no placeholders, no "TBD")
- [ ] Root cause is identifiable by someone who has never seen this bug before

---

## Reference: Error Type Quick Reference

### Crashes / Exceptions

- **Read the stack trace bottom-to-top** — the first frame in *your* code is where to start looking.
- Common causes: `None`/`null` dereference, index out of bounds, type mismatch (string vs number, object vs array), missing property on unexpected shape.
- **Check the input first**: Log/replay the exact input that caused the crash. Nine times out of ten the input violates an implicit assumption.

### Logic Errors (wrong output, silent data corruption)

- **Add logging at decision points**: Log the values of all variables involved in conditionals, loops, and arithmetic before the point where output diverges.
- **Compare expected vs actual**: If you have a known-good version, diff the output. If not, trace a single input through the logic manually or by adding print statements.
- **Look for**: Inverted conditionals (`if not x` vs `if x`), off-by-one (`<=` vs `<`), operator precedence, mutation of shared state, wrong variable used in a calculation.

### Performance Issues (slow, high memory, timeout)

- **Profile before optimizing**: Use the platform's profiling tools (Node: `--cpu-prof`, Python: `cProfile`, browser: Performance tab). Do not guess where the bottleneck is.
- **Common patterns**: N+1 queries (loop-fetches in a DB call), O(n²) nested loops over large datasets, unnecessary serialization/deserialization, event loop blocking, memory leaks from retained references.
- **Fix only the bottleneck**: If the slow part is a DB query, optimize the query — do not optimize the rendering code.

### Intermittent / Flaky

- **Look for non-determinism**: Shared mutable state, unhandled async timing, unseeded randomness, date/time dependencies, network timeouts, file system races.
- **Add a stress test**: Run the operation 100 times in parallel. If the failure rate goes up, you have a race condition.
- **Add a minimal sleep/retry log**: If adding a 100ms delay before the critical section makes the bug disappear, you have a race condition. Do not ship the sleep — fix the race.

---

## Handoff Checklist

Before finishing, confirm each item:

- [ ] Step 1 (Reproduce): Reproduction exists, is isolated, and is reliable (or documented as non-reproducible)
- [ ] Step 2 (Diagnose): Root cause identified with evidence, stated in one sentence
- [ ] Step 3 (Fix): Surgical fix — minimal diff, no refactoring
- [ ] Step 4 (Verify): Bug confirmed fixed, all tests pass, edge cases checked, callers verified
- [ ] Step 5 (Report): Report written to `.opencode/context/debug-output.md` — all sections complete
- [ ] Root cause is the actual origin, not a symptom
- [ ] No speculative/defensive changes added beyond what the root cause requires
- [ ] Prevention recommendations are specific and actionable (not "write better tests")
