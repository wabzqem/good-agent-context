# Agent-task memory pilot

Follow-up: [expanded-memory sequential protocol](sequential-protocol.md) and [results](results-sequential-2026-09-27.md).

This pilot tests whether Good Agent Context helps a fresh coding agent complete unfamiliar repository tasks with less effort. It compares a tool-free baseline with an otherwise identical run that can call GAC `recall`. The result is a paired case study, not a statistically powered benchmark.

## Fixed inputs

- Public repository: [`antfu-collective/ni`](https://github.com/antfu-collective/ni), commit `2d8c88e9f0d302da75eda36e1a158141714a351e`.
- Model: `gpt-6-sol`, medium reasoning effort, Codex CLI 0.155.0, ephemeral session, ignored user config, auto-reviewed workspace sandbox.
- Memory scope: `repository:ni-eval-2d8c88e`, mapped by `.good-agent-context.yaml` in each checkout. A separate onboarding agent stored 24 source-backed memories from the pinned snapshot before tasks were selected or shown to it.
- Tasks: [ancestor script picker](task-353.md) and [layered `.nirc` discovery](task-362.md), based on open upstream issues [#353](https://github.com/antfu-collective/ni/issues/353) and [#362](https://github.com/antfu-collective/ni/issues/362).
- Each attempt starts in a fresh worktree at the same commit with dependencies installed and the same task prompt. The treatment has only the `recall` MCP tool; baseline has no GAC server. No agent can write GAC memories during task attempts.

## Procedure

1. Clone the pinned repository and add the same repository-scope `.good-agent-context.yaml` to each checkout. Sync the scope once to the local GAC service.
2. Run [the seed prompt](seed-prompt.md) in the source checkout with `run-codex.mjs seed`, and verify that memories describe only pre-task code.
3. Create fresh baseline and treatment worktrees. Run `run-codex.mjs` with the appropriate task prompt. Keep runs sequential to avoid compute contention. Save its `events.jsonl`, `stderr.log`, and `summary.json` outside the worktree.
4. Run `grade.mjs` after each attempt. It injects an independent held-out Vitest check temporarily, runs typecheck, saves logs and a `grade.json`, then removes the check. Inspect each patch and agent-authored tests as well.
5. Compare held-out correctness first, then input/output tokens, uncached input tokens, time, command count, and GAC calls. An improvement must be consistent across multiple tasks and repeated seeds before claiming it generalizes.

The untouched snapshot has four failing catalog tests out of 729 and a `src/catalog/handler.ts:131` type error. These are pre-existing failures, not task regressions; inspect the grade logs for new diagnostics. Agent tests are useful but not treated as independent correctness checks.

## Limitations

This pilot has one seed, one model, two tasks, and one attempt per arm. Task difficulty and run-to-run model variance can dominate the result. GAC server startup and tool schemas also count toward the treatment cost. Follow-up experiments should rotate arm order, repeat each task with several seeds, expand to at least one other repository, and pre-register task-specific grading before drawing a cost or quality conclusion.
