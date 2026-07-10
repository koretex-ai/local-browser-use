# Planner action-selection bench — results

**Date:** 2026-07-10 · **Harness:** `run.mjs` (14 cases × 3 trials, temp 0.1, json mode, think off) · **Hardware:** M3 Pro 18GB, Ollama 0.31.1

| Model | Accuracy | Parse failures | Median latency | p90 |
|---|---|---|---|---|
| **qwen3.5:4b** ✅ | **90.5%** (38/42) | 0 | 2.5s | 2.9s |
| qwen3:4b | 85.7% (36/42) | 0 | 2.1s | 2.6s |
| qwen3.5:2b | 57.1% (24/42) | 0 | 2.3s | 2.6s |
| granite4:3b | 57.1% (24/42) | 0 | **1.0s** | 1.3s |

## Decision: qwen3.5:4b locked as default planner

- Clear accuracy leader; previous-gen qwen3:4b trails by ~5pts with no latency win.
- The 2B–3B class collapses on this task (57%): both fail answer-extraction
  (`done-extract-answer`), `back`-recovery, and form-fill — core loop skills.
- granite4:3b is 2.4× faster but speed doesn't compensate for wrong actions:
  a wrong click costs a full perceive→plan→execute round trip (~8–10s).

## Universal failure worth fixing in the prompt (not the model)

`respond-pure-chat` failed 3/3 on **every** model: given a general-knowledge
question ("difference between RAM and SSD?"), all planners navigate to Google
instead of choosing `respond`. Arguably agentic, but our design wants local
answers for pure conversation. → Add an explicit rule/example to the planner
prompt; re-bench that case.

Other qwen3.5:4b misses: `pagination` 1/3 (picked a thread link instead of
the page-2 link — index disambiguation under similar labels).

## Notes

- All models produced valid JSON in all 168 calls (json mode + shape-in-prompt;
  schema-object `format` is broken with think:false on qwen3.5, see planner.ts).
- Challenger models were deleted after the bench. Re-pull tags:
  `qwen3.5:2b`, `granite4:3b`, `qwen3:4b`.
