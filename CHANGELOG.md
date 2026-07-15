# Changelog

All notable changes to contract-ops-agent. Dates are release dates.

## 0.8.0 — 2026-07-15

**Security** (found by an adversarial review of the signing surface)
- **RCE fix (critical):** the Claude sign mount interpolated the workspace
  path into `sh -c` via `JSON.stringify`, which does not escape `$(…)` or
  backticks — a workspace like `/tmp/wk$(…)` executed code at session start.
  The path is now a positional shell parameter, never parsed as code.
- **Signing-gate hardening (high):** the `document` act (one-shot seal of any
  file) uses `input_path`, which the gate didn't read — the typed challenge
  collapsed to the generic word "document" and the gate mis-said "no target".
  Target resolution now covers the real sign-cli params; the challenge is the
  full target (basenames collide); an empty-string field can't mask a real
  one; and a signing act with no resolvable target is denied.
- A signing act can only be approved from an **interactive TTY** — piped input
  can never confirm a signature.
- Defense-in-depth: the `run` sign-guard normalizes casing/whitespace;
  `convert_to_pdf` approval keys on the exact output file, not the directory.

**Signing on every provider**
- Signing works on all providers with a **current sign-cli**; the harness adds
  `--capability tools` (no stray resource tools) and blocks startup until the
  sign server connects. A too-old sign-cli aborts loudly ("no sign tools
  mounted") instead of running a session that only looks signing-capable.

**Other**
- MCP mounts connect concurrently (faster signing-mode startup).
- Platform support stated (macOS/Linux; Windows via WSL/Docker).
- Added `docs/beta-onboarding.md` and backfilled this changelog.
- First Claude live-suite run since v0.3 (L1–L12 green).

## 0.7.0 — 2026-07-15

**Fixes**
- Fallback chains now fire when Claude is the primary provider (SDK error
  subtypes are normalized into the same `meta.error` the loop uses), and a
  session that *throws* (SDK crash) gets the fallback chance instead of a
  fatal exit. Enclosure failures still never retry.
- Signing `full` mode passes the `--tool` whitelist too, so a sign-cli upgrade
  that adds tools can no longer surprise-breach the enclosure assertion.
- The typed-consent gate can never present an empty challenge (degenerate
  targets fall back to the tool name) and an empty answer never approves.
- The setup wizard records `keyOptional` for keyless custom endpoints — they
  used to fail the key preflight on the next launch.
- Fallback refs that resolve to the provider that just failed are skipped; an
  exhausted chain says so; the fallback seed is capped so failover can't blow
  the next model's context; `--resume` history is carried into the fallback
  seed.
- `/model` switch clears gate approval memory ("context resets" now means it);
  tool-server connects time out at 30s instead of hanging; version strings are
  single-sourced from package.json; stray sign.db artifacts untracked.

**Discoverability**
- `doctor` validates signing config (mode, sign-cli presence, activation hint)
  and resolves every fallback ref + key up front.
- `/help` shows live session state (model · signing · fallbacks); README,
  `--help`, and the wizard cover fallbacks and signing consistently.

## 0.6.0 — 2026-07-15

- **Signing modes** (default off, double opt-in via `signing.mode` config +
  `--enable-signing` flag): `prepare` mounts sign-cli's own MCP server
  least-privilege (tracking, audit/receipt verification, field detection,
  preview stamps — the signing act does not exist in the session); `full`
  adds the signing act, each act behind a typed-consent gate (type the
  target back; never y/N, never remembered). Design record:
  `docs/sign-mount-scope.md`.
- Loop runtime generalized to multiple MCP mounts with per-prefix routing;
  a failed mount fails the session closed.

## 0.5.0 — 2026-07-15

- **Fallback chains**: `fallbacks: ["ref", …]` in config — on a terminal
  provider error the REPL fails over to the next viable ref, re-seeds the
  conversation, and replays the unanswered message.
- **Zero-setup container**: `ghcr.io/drbaher/contract-ops-agent` bundles the
  agent, all nine CLIs, and LibreOffice; config persists on a `/config`
  volume. Built and pushed on every release tag (amd64 + arm64).
- Piped stdin that ends before the REPL starts resolves cleanly instead of
  hanging; a failed first-run config write exits with the reason.

## 0.4.0 — 2026-07-15

- **Preset endpoints**: `gemini/…`, `grok/…`, `deepseek/…`, `openrouter/…`,
  `ollama/…` work with zero config; custom `providers` entries override
  presets.
- **`/model` switching** mid-session (context resets, enclosure re-verified).
- **`--resume [last|<transcript>]`**: Claude resumes the SDK session natively;
  loop providers re-seed from the transcript.
- **`tool` passthrough**: run one contract-ops tool directly, no model — same
  MCP mount, same gates.
- Per-provider system prompt (loop providers get tool-use discipline).

## 0.3.1 — 2026-07-15

- Resilient loop: transient provider errors retry with backoff; terminal
  errors and interrupts end the turn, never the session; MCP failures become
  tool errors; corrupt config and missing keys fail at startup with guidance.
- REPL polish: spinner, per-turn cost/token footer, `/help`, piped input.
- Provider-aware doctor + v1→v2 config migration; context compaction on loop
  providers; README rewritten for the provider era.

## 0.3.0 — 2026-07-15

- **Provider abstraction (bring-your-own-model)**: Claude via the Agent SDK
  (keeps subscription auth) or any OpenAI-compatible endpoint via the
  harness's own tool-calling loop — same enclosure, same gates on every
  backend. Config v2 (`provider/model` refs), wizard provider selection,
  universal compatible-endpoint support.

## 0.2.x — 2026-07-14

- Guided onboarding: first-run wizard (CLI install, workspace, auth), doctor,
  clearer startup guidance. 0.2.1 polished the wizard copy and fixed
  fill_template/sign-guard integration.

## 0.1.x — 2026-07-13

- Initial release: the enclosed contract agent (Agent SDK, contract-ops MCP
  tools only, three-layer enclosure, human gates on consequential tools,
  JSONL transcripts), npm packaging via OIDC trusted publishing.
