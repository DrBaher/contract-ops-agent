# contract-ops-agent

A terminal agent for contract work, in an **enclosure**: the agent's only tools
are the [contract-ops](https://cli.drbaher.com/) suite, exposed through
`contract-ops-mcp`. No shell, no filesystem access, no web, no signing — not by
policy but by construction. If a request can't be served by extract, lint,
compare, fill, convert, review, the vaults, or verify, the agent literally has
no way to do it.

Bring your own model: Claude (API key or your existing Claude Code login),
OpenAI, or any OpenAI-compatible endpoint (Gemini, Grok, DeepSeek, Ollama,
OpenRouter, a local server…). The enclosure is identical on every backend.

Scope and rationale: `docs/contract-ops-agent-scope.md` (Tier 3),
`docs/provider-abstraction-scope.md` (v0.3 providers), `docs/providers.md`
(how to point it at any endpoint).

## Install & run

```bash
npm install -g contract-ops-agent
contract-ops-agent          # first run: a one-time setup wizard, then the REPL
```

(From a source checkout: `npm install` then `node bin/contract-ops-agent.mjs`.)

The **first run** walks a short wizard — it checks which contract-ops CLIs are
installed (and offers to install any that are missing), picks your workspace
directory, and picks your **model & auth**: Claude, OpenAI, or a custom
OpenAI-compatible endpoint — then drops you into the agent. Every later run
goes straight to the REPL. Config is saved under
`~/.config/contract-ops-agent/` (any secret lives in a separate `0600` file, never in
`config.json` or a transcript).

```
contract-ops-agent [--workspace <dir>] [--model <model>]   start the agent
contract-ops-agent --resume [last|<transcript.jsonl>]      continue a prior conversation
contract-ops-agent setup                                   (re)run the setup wizard
contract-ops-agent doctor                                  check environment + auth; migrate old configs
contract-ops-agent tool [<name> ['{json}']]                list tools, or run one directly (no model)
```

In the REPL, type contract requests in plain language; `/help` lists commands;
`/model` shows or switches the model mid-session (`/model gemini` — context
resets, the enclosure is re-verified); `/quit` (or Ctrl-D) exits; Ctrl-C
interrupts the current turn, twice to exit. While the model works you get a
spinner, each executed tool is echoed as `⚙ tool {args}`, and every turn ends
with an accounting footer (tool calls, and cost or token usage depending on
the provider). Input can also be piped: `echo "lint agreement.md" |
contract-ops-agent` runs one scripted session.

`tool` is the model-free path: `contract-ops-agent tool lint_contract
'{"path":"agreement.md"}'` drives one CLI through the same MCP mount — same
path confinement, same sign guard, and consequential tools still ask first.

The contract-ops CLIs must be installed (the MCP server shells out to them);
`doctor` and the first-run wizard tell you which are missing and can install them.

## Providers & auth — bring your own

The model is a config choice (`model: "provider/model"` ref, wizard step 3):

- **`claude`** (default) — runs on the Claude Agent SDK. Auth is either
  **`ANTHROPIC_API_KEY`** (pay-per-token) or **your existing Claude Code
  login** — the SDK inherits that session; sanctioned for personal use, drawing
  from your normal subscription limits.
- **`openai/<model>`** (e.g. `openai/gpt-4o`) — runs the agent's own
  tool-calling loop against the OpenAI API. Auth is **`OPENAI_API_KEY`**, from
  your environment or stored (0600) by setup.
- **Presets** — `gemini/<model>`, `grok/<model>`, `deepseek/<model>`,
  `openrouter/<model>`, and `ollama/<model>` (local, no key needed) work with
  zero config: base URL and key variable are built in, just add the key.
- **Any other OpenAI-compatible endpoint** — a `providers` entry in config
  (the wizard's "other endpoint" path) with a `baseUrl`, key env var, and
  default model makes `myendpoint/<model>` work with no new code. See
  `docs/providers.md`.

The harness implements no login flow of its own and never handles your
credentials beyond storing a key you paste (masked) into setup. A missing key
is caught at startup with a pointer to setup, not a mid-session crash.

## The enclosure

The guarantee is the same on every backend: **the model only ever sees the
contract-ops tools**, every consequential tool passes a human gate, and the
session refuses to start if anything else is mounted.

On **Claude** (Agent SDK), that's three layers:

1. **Context stripping** — `disallowedTools` removes every built-in and harness
   tool from the model's view. (It must stay an explicit list: `["*"]` strips the
   MCP tools too and leaves zero tools.)
2. **Gate deny** — a `canUseTool` policy denies anything not matching
   `mcp__contract-ops__*`, and requires human approval for consequential tools
   (`fill_template`, `convert_to_pdf`, the `run` escape hatch).
3. **Startup assertion** — the harness reads the SDK's init message and refuses
   to run unless every mounted tool is a contract-ops tool. This is the real
   guarantee; layers 1–2 are how it's satisfied. `strictMcpConfig` +
   `settingSources: []` keep out inherited MCP servers (including claude.ai
   connectors) and local settings.

On **every other provider**, the harness owns the loop, so layer 1 is a
property of construction — the tool list handed to the model is built *only*
from the contract-ops MCP server; there are no built-ins to strip. The gate
(layer 2) and the startup assertion (layer 3) are the same code on both paths.

**Signing** is unreachable here by design — the loop ends at "ready for
signature" and hands off to the human's sign-cli flow.

A provider failure never loses your session: transient errors (rate limits,
network, 5xx) retry with backoff, anything else ends the *turn* with a clear
message and the conversation continues. Long sessions on loop providers are
trimmed at a safe message boundary before they can blow the context window.

Every tool call, gate decision, and result is recorded to a JSONL transcript
under `transcripts/` (git-ignored).

## Tests

```bash
npm test                  # unit + onboarding + resilience — offline, no API usage
npm run test:loop         # the raw loop over the real CLIs (stubbed model, offline)
npm run test:live         # real Claude sessions + real CLIs (uses your quota)
npm run test:live:openai  # real OpenAI requests through the loop (needs OPENAI_API_KEY)
npm run spike             # the original M0 enclosure spike
```
