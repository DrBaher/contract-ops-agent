# contract-ops-agent — Provider Abstraction ("Bring Your Own Model") Scope

**Status:** Draft for approval · 2026-07-14
**Goal:** Make the agent **provider-agnostic** — run the same enclosed contract workflow on Claude, OpenAI (GPT), Google (Gemini), or any OpenAI-compatible endpoint — **without weakening the enclosure**. Modeled on OpenClaw's architecture (thin generic loop + provider plugins that own auth/catalog/transport), but with a hard invariant OpenClaw does not have: the enclosure holds identically on every backend.

## 1. The one distinction that governs the whole design

- **Provider-agnostic (in scope):** *our* loop owns the agent turn; the LLM is swapped behind a `Provider` adapter. The model only ever sees the contract-ops MCP tools. **The enclosure holds.**
- **Agent-agnostic (OUT of scope, permanently):** running *inside* another agent (Codex, Claude Code). That host brings its own shell/file/web tools, so signing-is-human-gated and no-shell evaporate. We never do this — it is the negation of the product.

Everything below serves the first and forbids the second. (OpenClaw itself is deprecating its Codex *runtime* backend in favor of the direct `openai` provider — independent confirmation that "direct to the provider API" is the right axis, not "inside Codex.")

## 2. Why this is achievable: the core is already provider-neutral

The thing that does the work — `contract-ops-mcp` — speaks **MCP, an open standard**. Only the *agent loop* is Claude-coupled (it's built on `@anthropic-ai/claude-agent-sdk`). Replace that loop and everything else carries over.

| Stays unchanged | Replaced / new |
|---|---|
| `gates.mjs` (gate policy — pure) | `options.mjs` + `repl.mjs` (Claude Agent SDK glue) → new loop + adapters |
| `system-prompt.mjs`, `transcript.mjs` | `mcp-client.mjs` (own the MCP connection) |
| `config.mjs`, `setup.mjs`, `doctor.mjs`, `preflight.mjs` | `providers/*.mjs` (per-LLM adapters) |
| `enclosure-assert.mjs` (reused against the MCP tool list) | `loop.mjs` (generic tool-calling turn) |

## 3. The enclosure gets *simpler*, not harder

Today the enclosure is a fight: the Claude Agent SDK ships built-in tools, so we strip them (`disallowedTools`), deny via `canUseTool`, and assert at startup — three layers to *remove* capability.

When **we** own the loop, the model only ever receives the tool list we hand it — the contract-ops MCP tools, nothing else. **There are no built-ins to strip; the enclosure is the default.** The three layers collapse to two, both stronger:

1. **Tool-set construction (Layer 1+2 merged):** the loop lists tools from the MCP client and passes *only* those to the provider. A non-contract-ops tool cannot exist in the model's view because we never create one.
2. **Startup assertion (Layer 3, unchanged):** `enclosure-assert.mjs` verifies every tool from the MCP client matches `mcp__contract-ops__*` (here, the raw MCP tool names) before the first turn; abort otherwise. Guards against a mis-mounted or extra MCP server.
3. **Gate (unchanged):** `gates.mjs` `decide()` runs before every tool execution in the loop — read-only auto-allow, consequential confirm, `run`+`sign` deny, everything-else deny. This is now *our* code in *our* loop, not an SDK callback.

Signing stays unreachable: the `run`+`sign` client-side deny and the server's `assertSignReadOnly` both still apply (the server is unchanged).

## 4. Architecture (OpenClaw-style: generic loop + provider adapters)

```
bin/contract-ops-agent.mjs
  └─ loop.mjs                 generic agent turn: send → tool-calls → gate → execute (MCP) → feed back → repeat
       ├─ providers/index.mjs resolve provider/model ref → adapter
       │    ├─ providers/claude.mjs    Anthropic Messages API + tool_use dialect
       │    ├─ providers/openai.mjs    OpenAI Responses/Chat + function-call dialect
       │    ├─ providers/google.mjs    Gemini (later)
       │    └─ providers/openai-compatible.mjs   any baseUrl+apiKey OpenAI-shaped endpoint
       ├─ mcp-client.mjs      spawn/connect contract-ops-mcp (stdio), listTools(), callTool()
       ├─ gates.mjs           decide() — unchanged
       └─ enclosure-assert.mjs  verify tool list — unchanged
```

### The `Provider` interface (the only per-LLM surface)

Mirrors OpenClaw's "plugins own catalog/auth/transport; the shared runner keeps only the generic inference loop."

```
Provider {
  id                       // "claude" | "openai" | "google" | "<custom>"
  envKeys                  // e.g. ["ANTHROPIC_API_KEY"] — for BYOK detection/wizard
  defaultModel             // e.g. "claude-opus-4-8"
  async run({ system, messages, tools, model, signal }) -> {
    text,                  // assistant text this turn
    toolCalls: [{ id, name, input }],   // normalized across dialects
    stop,                  // "end_turn" | "tool_use" | "refusal" | "max_tokens"
    raw                    // provider-native message, echoed back next turn unchanged
  }
  formatToolResult(id, content, isError) -> provider-native tool-result message
}
```

The adapter owns the dialect (Anthropic `tool_use`/`tool_result` vs OpenAI `tool_calls`/`tool` role), auth env-var mapping, and streaming. `loop.mjs` never sees a provider-specific shape.

### Model refs

Adopt OpenClaw's `provider/model` format everywhere: `claude/claude-opus-4-8`, `openai/gpt-5.6`, `google/gemini-...`, `custom/<id>`. The config stores one ref; `providers/index.mjs` splits it.

### Build vs. framework

- **Recommended: hand-rolled minimal loop** on the official `@modelcontextprotocol/sdk` client + each provider's official SDK. Maximum enclosure control, no "magic," tiny surface (the loop is ~100 lines; each adapter ~80). The tool-calling dialect diff (Anthropic vs OpenAI) is small and well-understood.
- **Alternative: a multi-provider framework** (Vercel AI SDK `ai`, OpenAI Agents SDK, Pydantic AI) that already normalizes providers + MCP + a tool-approval hook. Less dialect code, but a heavy dependency and less direct control over the enclosure. Reach for it only if adapter maintenance becomes a burden.

## 5. Config & wizard changes (OpenClaw-informed)

`config.json` gains a provider/model + a providers block; the secret still lives only in `credentials.json` (0600), now keyed per provider.

```json5
{
  "version": 2,
  "workspace": "/path",
  "model": "claude/claude-opus-4-8",        // provider/model ref
  "auth": { "mode": "api-key" },            // per active provider
  "providers": {                             // optional: OpenAI-compatible endpoints
    "custom": { "baseUrl": "https://api.example.com/v1", "api": "openai" }
  }
}
```

- **Wizard auth step gains `--auth-choice`** (OpenClaw pattern): "Which model provider? Anthropic / OpenAI / Google / other (OpenAI-compatible)" → maps to the right env key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`) and the same `env` | `api-key` | `claude-code` storage rules. `claude-code` remains Claude-only (delegate-don't-implement; the subscription-login policy line is unchanged and applies only to the Claude provider).
- **`doctor`** additionally reports the configured provider, whether its key/auth is present, and the resolved model ref. Config migrations (v1→v2) live in doctor, never runtime shims (OpenClaw discipline).
- **Optional later:** a `fallbacks` chain (`model.fallbacks`) and key-rotation-on-429, both cheap reliability wins OpenClaw ships.

## 6. Per-provider realities to handle

- **Tool-calling dialect** (adapter-owned): Anthropic `tool_use`/`tool_result`; OpenAI `tool_calls` + `role:"tool"`. Both are request/response loops; the normalization is mechanical.
- **System-prompt tuning:** the prompt tuned for Claude may need light per-model variants (GPT/Gemini refusal + tool-eagerness differ). Keep a base prompt + optional per-provider addendum.
- **Refusal/stop handling:** normalize each provider's stop reason into the `stop` field; a provider refusal is surfaced, not retried blindly.
- **Auth precedence:** explicit env var always wins over the stored key (unchanged rule from `applyAuth`).

## 7. What we deliberately do NOT take from OpenClaw

OpenClaw is a **capability-maximizing** general assistant. Its strengths are the opposite of ours; copying them would erode the product:

- **No messaging channels / gateway / always-on process.** We are a local CLI for contract work.
- **No persistent cross-session memory system.** A memory surface is exactly where an enclosed tool leaks; out of scope.
- **No skills marketplace / device access / broad tool sprawl.** The tool set is the nine contract-ops CLIs, period.
- **No agent-agnostic "run inside Codex" runtime.** §1.

We take OpenClaw's *plumbing* (provider adapters, `provider/model` refs, BYOK `--auth-choice`, OpenAI-compatible endpoint config, doctor-owned migrations) and keep our *philosophy* (the enclosure is the product).

## 8. Milestones

| # | Milestone | Content |
|---|---|---|
| M1 | Loop + Claude provider at parity | Build `mcp-client.mjs`, `loop.mjs`, `providers/claude.mjs`; retire the Claude Agent SDK from the run path; **all 12 live tests pass unchanged** (behavior parity is the gate) |
| M2 | OpenAI provider | `providers/openai.mjs` + dialect normalization; live suite runs green on `openai/*` too |
| M3 | Config v2 + multi-provider wizard | `provider/model` refs, `--auth-choice`, per-provider credentials, `providers` block for OpenAI-compatible endpoints, doctor v1→v2 migration |
| M4 | Google + hardening | `providers/google.mjs`; optional fallback chain + 429 rotation; docs |

M1 is the load-bearing one: it proves we can drop the Claude Agent SDK without losing the enclosure or any behavior. M2 proves the abstraction is real.

## 9. Test plan (the enclosure must hold on every backend)

- **Parameterize the live suite (L1–L12) by provider.** Same assertions, each provider: zero non-contract-ops tool calls, gates fire, signing unreachable, extract→lint/compare/vaults/review/convert all drive the real CLIs. A provider passes only if the full enclosure holds.
- **Unit:** provider-ref parsing; adapter dialect round-trips (tool_use ↔ normalized ↔ tool_result) with a stubbed transport; `enclosure-assert` over the MCP tool list; gate parity (unchanged `gates.mjs` tests still green).
- **Enclosure probe per provider (L1):** each model, asked to run shell / write files / fetch web, invokes zero non-MCP tools — because none exist in its tool list.
- Pass bar: **L1–L12 green on Claude *and* OpenAI**, zero unexplained tool events in any transcript, on any provider.

## 10. Risks

- **Enclosure strength is per-loop, and now it's ours** — a bug in `loop.mjs` that leaks a non-MCP tool would breach it. Mitigation: the tool list is constructed in exactly one place (from the MCP client), asserted at startup, and gated per call; the parameterized L1 probe tests it live per provider.
- **Losing the Claude Agent SDK's conveniences** (context compaction, subagents). This focused loop doesn't need them; if long transcripts become an issue, add simple truncation/compaction in `loop.mjs` later.
- **Tool-calling reliability varies by model** — some models are worse at multi-tool sequencing. Surfaced by running the live suite per provider; prompt tuning per §6.
- **Maintenance: N provider dialects.** Bounded (2–3 providers cover most users); the OpenAI-compatible adapter covers the long tail with zero new code.

## 11. Decisions for you

1. **Scope of first release:** Claude+OpenAI (M1–M2) as v0.3.0, or push straight to Claude+OpenAI+Google?
2. **Build vs framework** (§4): hand-rolled minimal loop (recommended) or a multi-provider framework?
3. **Timing:** do M1 (drop the Agent SDK behind a `Provider` interface, Claude-only, parity) *now*, or after the friend's real-world test on the current Claude build validates the product?

Recommendation: run the friend's test on the current build first (it validates the enclosure + workflow, which are provider-independent), then build M1→M2 hand-rolled for Claude+OpenAI as v0.3.0.
