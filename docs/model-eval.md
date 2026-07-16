# Which models can drive the agent? — a cross-model eval

`contract-ops-agent` is bring-your-own-model, but the enclosure holding on every
backend (which it does, by construction) is a different question from whether a
given model can actually *drive* the tools. This eval answers the second one.

## Method

`eval/cross-model.mjs` runs five core scenarios against a provider and scores
two things per scenario: did it call the **right tool**, and did the final
answer contain the **expected content**. It uses the real MCP server (all 50
tools) and the real system prompt — the same surface a user gets.

| Scenario | Prompt gist | Expected tool |
|---|---|---|
| extract | extract agreement.md, name the parties | `extract_contract` |
| lint | lint agreement.md, list findings | `lint_contract` |
| compare | compare v1 vs v2 | `compare_versions` |
| fill | fill a template with params | `fill_template` |
| review | review an NDA against the playbook | `review_nda` |

Run it yourself:

```bash
OPENAI_API_KEY=... node eval/cross-model.mjs openai gpt-4o
node eval/cross-model.mjs claude
node eval/cross-model.mjs ollama qwen2.5:7b     # local, no key
```

## Results (2026-07-16)

| Model | Backend | Score | Tool selection | Notes |
|---|---|---|---|---|
| **Claude** (Agent SDK default) | Claude | **5/5** | 5/5 | ~7–13s/scenario |
| **gpt-4o** | OpenAI | **5/5** | 5/5 | ~3–5s/scenario |
| **qwen2.5:7b** | Ollama (local) | **0/5** | 0/5 | overwhelmed by 50 tools |
| **qwen2.5:14b** | Ollama (local) | **0/5** | 0/5 | same ceiling as 7b — see the sweep below |

## What the Ollama result actually means (it's nuanced)

The 0/5 is **not** a broken preset. Two isolated checks show the plumbing is
correct:

- With **one** tool in context, qwen2.5:7b returns a well-formed tool call and
  our OpenAI-dialect driver parses it correctly (`lint_contract{path:…}`).
- With the **full 50-tool** set + system prompt, the same model returns *no*
  tool call at all (empty response).

So the `ollama/` preset works — but a **7B model is overwhelmed by a 50-tool
enclosure**. Frontier models (Claude, gpt-4o) select cleanly from 50 tools; a
small local model does not. This is the empirical version of the tool-count
tradeoff: more curated tools help capable models and hurt weak ones.

## How many tools can a small model handle? (the ceiling sweep)

`eval/tool-ceiling.mjs` isolates the variable: it asks the model to lint a file
with **N** tools in context (always including the target `lint_contract`) and
reports the hit rate over several trials. Results on a 16 GB machine
(2026-07-16):

| Tools in context | qwen2.5:7b | qwen2.5:14b |
|---|---|---|
| 5 | 3/3 | 2/2 |
| 17 | 3/3 | 1/2 |
| 25 | 3/3 | 2/2 |
| 35 | **0/3** | **0/2** |
| 50 (full product) | **0/3** | **0/2** |

The striking result: **doubling the model (7B → 14B) did not raise the
ceiling.** Both are reliable up to ~25 tools, both fall off a cliff by 35, and
**both fail at the full 50.** So within the small-local range, the blocker is
the number of tools in context, not model size — a bigger *small* model doesn't
fix it. (Sample sizes are small and results are stochastic; the signal — a hard
cliff between 25 and 35 — is consistent across both models and repeated runs.)

## Recommendations

- **Cloud:** Claude or gpt-4o (or comparable) — both 5/5 at the full 50 tools,
  use freely.
- **Local (Ollama), full 50-tool surface:** a 7B or 14B model **won't** drive
  it. The `ollama/` preset is wired correctly (its tool calls parse), but the
  model can't select from 50 tools. Either:
  - use a **much larger** local model (32B/70B-class, untested here — needs a
    machine with ≥ ~32 GB RAM; run `node eval/cross-model.mjs ollama qwen2.5:32b`
    to check), **or**
  - **cap the tool set to ~20** for the small model — where a 7B is reliable.
- **The real lever for small models** is reducing the tools the model sees per
  turn (task-scoped tool subsets / deferral), independent of the enclosure. The
  enclosure holds at any tool count; tool *selection* is what a small model
  struggles with.

Reproduce: `node eval/tool-ceiling.mjs <model> [points] [trials]` (local via
Ollama by default; set `EVAL_BASE_URL` + `OPENAI_API_KEY` for a hosted model).

Untested (no keys available at eval time): Gemini, Grok, DeepSeek, OpenRouter.
Their dialect is the same OpenAI-compatible path that gpt-4o passed and the
Ollama driver-level check passed, so parsing should hold; tool-selection quality
will track each model's general tool-calling ability. Re-run the eval with a key
to confirm.
