# Model providers

contract-ops-agent is **bring-your-own-model**: the same enclosed contract
workflow (extract, lint, compare, draft, review, convert, the vaults, verify —
and *only* those) runs on whichever model you point it at. The enclosure holds
identically on every backend.

The `setup` wizard's Step 3 configures this; you can also edit
`~/.config/contract-ops-agent/config.json` directly. The model is a
**`provider/model` ref** (e.g. `claude`, `openai/gpt-4o`, `grok/grok-2`). Keys
live only in `~/.config/contract-ops-agent/credentials.json` (chmod 600), never
in `config.json` or a transcript.

## Anthropic Claude (default)

Runs on the Claude Agent SDK — the one backend that inherits a **Claude Code
subscription** login, so you don't need an API key if you already use Claude
Code. Or use an Anthropic API key.

```json5
{ "model": "claude", "auth": { "mode": "claude-code" } }              // subscription
{ "model": "claude", "auth": { "mode": "api-key", "envKey": "ANTHROPIC_API_KEY" } } // key
```

## OpenAI

Your own OpenAI key (`OPENAI_API_KEY`). Runs on the raw tool-calling loop.

```json5
{ "model": "openai/gpt-4o", "auth": { "mode": "api-key", "envKey": "OPENAI_API_KEY" } }
```

## Any OpenAI-compatible endpoint (Gemini, Grok, DeepSeek, Ollama, local, routers…)

Most model vendors and local servers expose an OpenAI-shaped API, so a single
adapter reaches all of them. Add a `providers` entry (base URL + which env var
holds its key) and reference it as `<name>/<model>`:

```json5
{
  "model": "gemini/gemini-2.0-flash",
  "auth": { "mode": "api-key", "envKey": "GEMINI_API_KEY" },
  "providers": {
    "gemini": { "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/", "apiKeyEnv": "GEMINI_API_KEY" }
  }
}
```

Common base URLs:

| Endpoint | Base URL |
|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| xAI Grok | `https://api.x.ai/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama (local) | `http://localhost:11434/v1` |

The wizard's **"3) Other endpoint"** option writes this block for you (name →
base URL → key → model). A local endpoint that needs no key: leave the key
blank.

## What's the same on every provider

The enclosure. Whichever model drives it:

- the **only** tools it ever has are the contract-ops MCP tools — no shell, no
  file access, no web (there are no other tools to call);
- consequential actions (`fill_template`, `convert_to_pdf`, the `run` escape
  hatch) require your approval at the gate;
- **signing is unreachable** — the agent hands off to the human sign-cli flow.

Subscription login is the one exception that's Claude-only (the raw Messages API
supports keys, not the consumer subscription); every other provider is
key-based.

## Notes

- **Claude** goes through the Agent SDK; **all other providers** go through the
  agent's own loop over the MCP tools. Same enclosure, different transport.
- Tool-calling reliability and prose style vary by model — the workflow is
  identical, the model's judgment is not.
