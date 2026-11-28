# System invariants

## Runtime P1 — R1 async gate

- `runCheck` and `runGate` are async. Every call site must `await` them; a synchronous gate blocks all sessions in the process.
- Every gate call passes the run `AbortSignal`. A check aborted by the run is not a normal red gate and must not trigger retry.
- An interrupted baseline is never persisted as a partial red baseline. Resume uses skipped/unavailable baseline and therefore strict checks.
- Abort is checked before commit, merge and accept. Pipeline `applyRun` receives the top-level signal, not only the conflict resolver signal.
- If abort happens after a merge created by this run, rollback is attempted only when HEAD still equals that merge commit and `reset --keep` is safe.
- `done` still requires a real passed gate and post-gate. Async conversion does not weaken baseline, merge or rollback semantics.
