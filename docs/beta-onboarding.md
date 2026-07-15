# Trying contract-ops-agent (beta)

A short guide for a first-time user setting the agent up with their own model.
Ten minutes, mostly install time. macOS or Linux (Windows: use the Docker
option at the end).

## What it is

A terminal agent for contract work in an **enclosure**: its only tools are the
contract-ops CLI suite (extract, lint, compare, fill, review, convert, the
vaults, signature *checks*). No shell, no file access, no web, and it can't
sign on your behalf — not by policy, by construction. You bring the model.

## 1. Install

```bash
npm install -g contract-ops-agent
```

It drives nine small command-line tools; the first run checks which are present
and offers to install the rest. To pre-install them yourself:

```bash
curl -fsSL https://cli.drbaher.com/install.sh | sh
```

## 2. First run — pick your model

```bash
contract-ops-agent
```

The one-time wizard asks three things: which CLIs to install, a workspace
folder (where your contracts live), and your **model**:

- **OpenAI** — paste an `OPENAI_API_KEY` (or have it in your env).
- **Gemini / Grok / DeepSeek / OpenRouter / Ollama** — pick the preset and
  add that provider's key. Ollama (local) needs no key.
- **Claude** — an Anthropic API key, or your existing Claude Code login.
- **Any other OpenAI-compatible endpoint** — base URL + key.

Codex users: choose OpenAI (or your OpenAI-compatible endpoint) and use the
same key.

The key is stored locally, `chmod 600`, in a file separate from the config —
never in a transcript, never sent anywhere but that provider.

## 3. Use it

Type what you want in plain language:

```
contract-ops-agent> extract agreement.md and lint it — summarize the parties and every finding
contract-ops-agent> fill template.md with client_name "Beta LLC" and effective_date 2026-09-01
contract-ops-agent> compare v1.md and v2.md
```

- It reads files in the workspace freely, but asks before it writes a file or
  runs anything beyond a read.
- `/help` lists commands; `/model gemini` switches model mid-session; `/quit`
  or Ctrl-D exits; Ctrl-C interrupts a turn.
- Every turn ends with a footer (tools used, cost or tokens). Everything is
  logged to `transcripts/` in your workspace.

Check your setup any time:

```bash
contract-ops-agent doctor
```

## 4. What to try, and what would help me

A real contract you'd normally lint or compare is the best test. I'm most
curious about:

- Did setup make sense end to end, or did any step stall?
- Did the agent stay useful, or did it try to do things it couldn't?
- Anything it refused that you expected to work (writes and the like are gated
  on purpose — but tell me if a gate felt wrong).

Paste me the last few lines of a `transcripts/*.jsonl` if something misbehaves.

## Optional: zero-setup via Docker

Nothing to install but Docker — the image bundles the agent, all the CLIs, and
a PDF backend:

```bash
docker run -it --rm \
  -v "$PWD:/workspace" \
  -v contract-ops-config:/config \
  -e OPENAI_API_KEY \
  ghcr.io/drbaher/contract-ops-agent
```

(On Linux, if writes fail on a bind mount, add `--user "$(id -u):$(id -g)"`.)

## Notes

- Signing stays impossible unless you deliberately opt in (config + a launch
  flag), and even then the agent only *prepares* — a human still signs.
- Signing modes currently need a loop provider (OpenAI/compatible), not the
  Claude provider.
