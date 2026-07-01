# Glossary — Agentic Orchestrator (Deus v2)

## Conductor
The primary orchestrator agent. Never executes — only classifies, plans, delegates, synthesizes. Runs on deepseek-v4-pro.

## Pipeline
A predefined execution flow in `src/orchestrator.ts`. Static (via `--pipeline` CLI flag) or dynamic (conductor selects by complexity).

## Dispatch
The act of calling `task()` with full context. Sub-agents have no shared memory.

## Loom
The cognitive process of weaving disconnected context pieces into a coherent prompt. The conductor's core skill.

## Ensemble
Pattern: multiple cheap flash-model agents in parallel instead of one pro model. Quality via redundancy.

## Completion Criterion
A checkable condition that marks a step as done. Should be unambiguous, not vague.

## Synthesis
The final aggregation of parallel/sequential outputs into one coherent report. Done by the conductor.
