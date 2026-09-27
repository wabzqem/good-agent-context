# Expanded-memory sequential pilot — 2026-09-27

See [the sequential protocol](sequential-protocol.md). The memory corpus grew from 24 to 74 active, source-backed entries: 52 new memories were stored, then two clear overlaps were withdrawn. After task 1, the outdated config-caching memory was superseded with a verified memory tied to the GAC arm's local task-1 commit, keeping the active count at 74.

Both arms passed the independent checks on both tasks, including a task-1 regression check after task 2. The GAC arm completed this two-task sequence faster and with fewer **total** input tokens, but used more **uncached** input tokens. Seeding remained much more expensive than the savings from these two tasks.

| Task | Arm | Held-out | Input tokens | Uncached input | Output tokens | Time | Shell commands |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Layered `.nirc` discovery (#362) | Baseline | 3/3 | 499,192 | 36,344 | 6,180 | 161 s | 20 |
| Layered `.nirc` discovery (#362) | GAC | 3/3 | 369,093 | 51,397 | 5,897 | 153 s | 18 |
| Missing explicit config warning (#368) | Baseline | 2/2; regression 3/3 | 558,052 | 37,732 | 5,721 | 152 s | 25 |
| Missing explicit config warning (#368) | GAC | 2/2; regression 3/3 | 538,493 | 33,405 | 4,136 | 120 s | 24 |
| **Two-task total** | **Baseline** | **Both pass** | **1,057,244** | **74,076** | **11,901** | **313 s** | **45** |
| **Two-task total** | **GAC** | **Both pass** | **907,586** | **84,802** | **10,033** | **273 s** | **42** |

Relative to baseline, GAC used 14.2% fewer total input tokens, 15.7% fewer output tokens, and 12.8% less elapsed time, while using 14.5% more uncached input tokens. It made one successful recall per task (about 3.6 and 3.9 seconds). The task-2 recall returned the new post-task-1 config memory first, without surfacing the superseded caching memory. No invalid capability-scope call occurred; the identical task prompts told both agents not to read external skill files and told an agent with recall access to let the checkout select its scope.

## Seeding cost and interpretation

The original 24-memory seed used 645,859 input tokens. The 52-memory top-up used another 1,000,295 input tokens, 6,376 output tokens, and 338 seconds. Thus seeding used **1,646,154 input tokens** before this sequence, excluding the small post-task-1 memory update. Including seeding, the GAC workflow used 2,553,740 input tokens versus 1,057,244 for baseline over these two tasks. The first seed's runner lost its elapsed-time summary while closing logs, so only the second seed's 338 seconds are a reliable recorded timing. The first seed trace and usage were preserved.

This is a positive task-run result, not evidence that the memory system has paid for itself. The extra uncached input is especially relevant to cost, and a larger corpus only helps when retrieval presents useful entries. The task-1 recall returned the old config memory along with several loosely related entries; the task-2 recall did place the newly updated config memory first. The first pilot's 24-memory task-#362 attempt used 460,636 input tokens and 156 seconds, but these figures cannot be attributed to memory count: this follow-up also removed the skill-reading/invalid-scope confound, changed the prompt, and used a new model run.

## Verification and limits

The untouched snapshot had 725 passing tests, four failing catalog tests, and one typecheck error at `src/catalog/handler.ts:131`. Both final worktrees had 732 passing and the same four failing catalog tests. The focused config suites, held-out checks, and `git diff --check` passed in both arms. Typecheck still reported only that pre-existing catalog error. Task-1 patches were committed only in temporary eval worktrees (`324a8e8` baseline, `0423f16` GAC); task-2 patches were left uncommitted for inspection. Nothing was pushed upstream.

The sequence has one attempt per arm and allows each arm's task-1 patch to shape task 2. Differences may reflect model variance or patch differences rather than memory alone. A stronger next experiment would repeat tasks with rotated arm order and multiple seeds, and give **both** arms the same MCP tool surface while varying only whether relevant memories are returned. That would separate tool/schema overhead from memory value. Independent grading should remain the primary outcome, with token and time comparisons conditional on correctness.

Raw event and grade logs are in `/private/tmp/gac-task-eval.3GI5Pk/sequence-*-60-task*-artifacts/` on this host. The top-up seed trace is in `/private/tmp/gac-task-eval.3GI5Pk/seed-top-up-artifacts/`.
