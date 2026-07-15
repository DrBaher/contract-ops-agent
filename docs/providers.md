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

## Preset endpoints — Gemini, Grok, DeepSeek, OpenRouter, Ollama

These need **zero config**: the base URL and key variable are built in, so a
`provider/model` ref just works once the key is present (wizard option 3, or
set the env var):

| Ref | Key env var | Default model |
|---|---|---|
| `gemini/<model>` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `grok/<model>` | `XAI_API_KEY` | `grok-3` |
| `deepseek/<model>` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `openrouter/<model>` | `OPENROUTER_API_KEY` | — (always name one) |
| `ollama/<model>` (local) | `OLLAMA_API_KEY` (optional) | — (always name one) |

```json5
{ "model": "gemini/gemini-2.5-flash", "auth": { "mode": "api-key", "envKey": "GEMINI_API_KEY" } }
{ "model": "ollama/llama3.3", "auth": { "mode": "env", "envKey": "OLLAMA_API_KEY" } } // no key needed
```

A `providers` entry with the same name **overrides** a preset (point `gemini`
at a proxy, `ollama` at another host…). Only `claude` and `openai` can't be
shadowed.

## Any other OpenAI-compatible endpoint (proxies, local servers, routers…)

Most model vendors and local servers expose an OpenAI-shaped API, so a single
adapter reaches all of them. Add a `providers` entry (base URL + which env var
holds its key) and reference it as `<name>/<model>`:

```json5
{
  "model": "myproxy/some-model",
  "auth": { "mode": "api-key", "envKey": "MYPROXY_API_KEY" },
  "providers": {
    "myproxy": { "baseUrl": "https://my-gateway.example/v1", "apiKeyEnv": "MYPROXY_API_KEY" }
  }
}
```

The wizard's **"4) Other endpoint"** option writes this block for you (name →
base URL → key → model). A local endpoint that needs no key: leave the key
blank (add `"keyOptional": true` to skip the startup key check).

## Fallback chains

`fallbacks` in config lists refs to try, in order, when a turn ends in a
terminal provider error (auth failure, model gone, endpoint down — transient
errors already retry with backoff and never trigger fallback):

```json5
{
  "model": "openai/gpt-4o",
  "fallbacks": ["gemini/gemini-2.5-flash", "claude"]
}
```

On failover the agent replays your unanswered message on the next viable ref
and re-seeds the conversation so far (loop providers keep context; a fallback
**to** `claude` starts contextless — the Agent SDK can't be seeded — and says
so). Refs whose key is missing are skipped with a notice. Each ref is used at
most once per session.

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
