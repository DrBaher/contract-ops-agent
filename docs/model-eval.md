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
| **qwen2.5:7b** | Ollama (local) | **0/5** | 0/5 | emitted no tool calls in the full flow |

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

## Recommendations

- **Cloud:** Claude or gpt-4o (or comparable) — both 5/5, use freely.
- **Local (Ollama):** the preset is wired correctly, but use a **larger** model
  than 7B (e.g. a 32B/70B-class instruct model with solid tool-calling) if you
  want the local path to drive the full workflow. A 7B model may work for a
  single-tool task but not the multi-tool flow.
- **If small-model support becomes a goal:** the lever is reducing the tool
  count the model sees per turn (tool-deferral / task-scoped tool subsets),
  not the enclosure — which is independent of model strength.

Untested (no keys available at eval time): Gemini, Grok, DeepSeek, OpenRouter.
Their dialect is the same OpenAI-compatible path that gpt-4o passed and the
Ollama driver-level check passed, so parsing should hold; tool-selection quality
will track each model's general tool-calling ability. Re-run the eval with a key
to confirm.
