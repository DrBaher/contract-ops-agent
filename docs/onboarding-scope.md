# legal-harness — OpenClaw-style Onboarding (v0.2.0 scope)

**Status:** Approved for build · 2026-07-13
**Goal:** Make the harness a self-contained agent you *install → set up → point at credentials → use* — the OpenClaw model. The "use it" engine (the enclosed agent driving all nine CLIs in combo) already ships in v0.1.2; this adds the onboarding layer around it.

## 1. The experience

```
$ npx legal-harness                 # first run
  → doctor: 6/9 CLIs present; install the missing 3? [Y/n]
  → workspace: ./contracts [Enter to accept]
  → auth: (1) API key  (2) Claude Code subscription
  → saved ~/.config/legal-harness/config.json
  legal-harness>                    # drops into the REPL

$ legal-harness                     # every later run: straight to the REPL
$ legal-harness setup               # re-run the wizard
$ legal-harness doctor              # re-check environment, offer installs
```

One-time wizard, persisted config, then you live in it. Re-runnable, never blocking.

## 2. Config

- **Location:** `$XDG_CONFIG_HOME/legal-harness/` (fallback `~/.config/legal-harness/`).
- **`config.json`** (non-secret): `{ version, workspace, auth: { mode }, model? }`.
- **`credentials.json`** (secret, chmod `0600`, separate file): `{ anthropic_api_key }` — only when the user chooses the stored-API-key mode. Never written to `config.json`, never to a transcript.
- **First-run detection:** `config.json` absent ⇒ run the wizard before the REPL.

## 3. Auth — *delegate, don't implement*

The single hard rule (OpenClaw's reinstatement came "with a catch"; the standing policy forbids a third-party product from *offering claude.ai login or rate-limits*). The harness never implements a claude.ai login flow. Three modes:

| Mode | What the wizard does | What's stored |
|---|---|---|
| `env` | Detects an already-set `ANTHROPIC_API_KEY` and offers to just use it | nothing |
| `api-key` | Prompts for a key, writes it to `credentials.json` (0600); bin loads it into `ANTHROPIC_API_KEY` at startup if unset | the key, in the secret file only |
| `claude-code` | Points the user at Claude Code's own login (`claude setup-token` / existing session); the SDK inherits that token | nothing (a mode pointer only) |

`claude-code` mode is the "cue in your Claude subscription" path — and it is a *delegation* to Claude Code's login, not a login the harness runs. That is the line that keeps distribution clear of the policy. The harness handles the API-key path directly; it never touches a claude.ai credential.

## 4. Doctor / bootstrap

- Reuses the existing preflight over the nine CLIs (`CLIS` from contract-ops-mcp) + a PDF-backend check (`soffice`/`libreoffice`).
- Reports: which CLIs are missing (+ each install command), PDF backend present?, which auth is configured.
- Offers to install missing pieces — the suite installer (`curl -fsSL https://cli.drbaher.com/install.sh | sh`) or the per-CLI commands from `CLIS`. **Install execution goes through an injected runner** so the *plan* (what/how) is pure and unit-tested; tests never run real installs.
- Degrades honestly: a missing CLI is a guided install, never a crash; a declined install just leaves that tool unavailable (preflight will keep flagging it).

## 5. Safety invariants (unchanged, must hold through onboarding)

- The enclosure still holds in the REPL (context strip + `canUseTool` deny + startup assertion). Onboarding adds no tools to the agent.
- Signing stays human-gated; the wizard/doctor never reach a sign write op.
- Secrets never land in `config.json` or a transcript; the API key lives only in the 0600 credentials file (or the env).

## 6. Non-goals

- **No claude.ai login flow** (delegate to Claude Code — §3).
- **No hosting / no credential proxying.** Local-first, BYO-auth.
- **No bundling the Python CLIs.** npm can't pull them; doctor *installs* them, it doesn't vendor them. The container image (`ghcr.io/drbaher/contract-ops`) remains the separate "zero-setup" path, out of scope here.
- **No direct-CLI passthrough yet** (`legal-harness lint …` running the raw CLI). Deferred; if added later it must keep the sign guard and path confinement (own decision gate).

## 7. Prerequisites (outside this build, block a real public launch)

1. **Distribution:** the repo is `private: true`, unpublished, no git remote — nobody but the author can install it. Publish/push is a separate decision.
2. **contract-ops-mcp `fill_template` fix must ship.** The harness depends on `contract-ops-mcp ^0.1.6`, which has the broken fill; the fix is staged in that repo, unpublished. A fresh install can extract/lint but can't author until a fixed version is published and the dependency bumped.

## 8. Modules & tests

| Module | Responsibility |
|---|---|
| `src/config.mjs` | config/credentials paths, load/save, first-run detection, `applyAuth` |
| `src/doctor.mjs` | `diagnose()` (CLIs + PDF + auth), `installPlan()`, `renderDoctor()` |
| `src/setup.mjs` | the wizard (injected `ask` prompter; writes config + credentials) |
| `bin/legal-harness.mjs` | `setup` / `doctor` subcommands; first-run auto-runs setup; load config + `applyAuth` before the REPL |

**Unit tests (`test/onboarding.mjs`, offline):** config round-trips and first-run detection against a temp config dir; credentials written 0600 and kept out of config.json; `applyAuth` sets `ANTHROPIC_API_KEY` only when unset; `diagnose`/`installPlan` over a stubbed bin-checker (missing CLI → its install command; PDF backend present/absent); the setup wizard driven by a scripted `ask` produces the right config for each auth mode and never stores a secret in config.json.

## 9. Acceptance (v0.2.0)

1. Fresh machine (no config): `legal-harness` runs the wizard, then the REPL; second launch skips to the REPL.
2. `legal-harness doctor` reports CLI/backend/auth status and offers installs.
3. API key entered in the wizard is usable next launch with nothing exported, and lives only in the 0600 credentials file.
4. `claude-code` mode starts the REPL on an inherited Claude Code login with no secret stored.
5. Full unit suite green; enclosure + sign invariants unchanged.
