# contract-ops-agent — Tier 3 Scope

**Status:** Draft v1 · 2026-07-13
**Decision:** Build the Tier 3 *enclosure*: a standalone agent built on the Claude Agent SDK whose only tools are the contract-ops MCP tools. The agent physically cannot act outside the suite — no Bash, no file editing, no freelance analysis paths.

## 1. Problem

When Claude is driven inside a general coding harness (Claude Code, Cursor, …) it has Bash, Edit, Write, and its own reasoning alongside the contract-ops tools. In practice it sometimes bypasses the suite: eyeballing a diff instead of `compare_versions`, hand-parsing a document instead of `extract_contract`, editing a draft inline instead of `fill_template`. Every bypass produces unaudited work — no exit-code gates, no vault trail, no deterministic template fill — and erodes the signing boundary the suite is built around.

Steering (CLAUDE.md routing) and gating (hooks/permissions) reduce this but cannot eliminate it: hooks intercept tool calls, not reasoning. The only structural fix is to shrink the agent's action space to exactly the sanctioned surface.

## 2. Product definition

A terminal agent — working name **`contract-ops-agent`** — that a contract-ops user runs instead of a general coding agent when doing contract work.

- Interactive chat loop in the terminal (ask → agent works → answer), with streamed progress.
- The agent's *entire* tool surface is `contract-ops-mcp` (§4). No shell, no file read/write tools, no web.
- The system prompt encodes the AGENTS.md operating loop: `suite_status` → extract/author → lint + compare gate → hand off to a human for signing → verify/track deadlines.
- Signing remains impossible from inside the harness in v1 (see §6).

### Non-goals (v1)

- **No umbrella CLI.** Merging the nine CLIs into one binary solves nothing here; the MCP server is already the single agent surface.
- **No hosted service.** Local-first, like the rest of the suite. Nothing runs on our infrastructure; no credentials pass through us.
- **No login flow of any kind.** See §5.
- **Not a general assistant.** Off-topic requests are declined by the system prompt; the closed tool set makes the refusal structural, not just behavioral.
- Tier 1/2 (CLAUDE.md kit + hooks for people who stay in Claude Code) is a separate, later deliverable.

## 3. Architecture

- **Runtime:** Claude Agent SDK (TypeScript — matches the existing Node/`.mjs` codebase and reuses the MCP server unchanged). Distributed like the MCP server: `npx contract-ops-agent` / one `bin` entry.
- **Tool mounting:** the SDK session mounts `contract-ops-mcp` as an MCP server (stdio). All built-in tools (Bash, Edit, Write, WebSearch, …) are disabled via the SDK's allowed-tools configuration. The enclosure is enforced by configuration, not prompting.
- **Model:** default to the strongest available model; configurable.
- **Sandbox:** inherits the MCP server's existing guarantees — `CONTRACT_OPS_MCP_BASE_DIR` path confinement, `execFile` (no shell), sign-subcommand allowlist on the `run`/`catalog` escape hatches.
- **Escape hatch policy:** `catalog`/`run` stay mounted (they're needed for the long tail and already enforce the sign allowlist), but the harness adds a confirmation gate (§4) on `run` since it's the widest tool.

## 4. Tool surface & human gates

Mounted (from contract-ops-mcp, unchanged): `extract_contract`, `lint_contract`, `compare_versions`, `fill_template`, `convert_to_pdf`, `review_nda`, `template_vault_find/get`, `contract_vault_query/due/risk`, `verify_signature`, `verify_receipt`, `audit_show`, `catalog`, `run`, `suite_status`.

Human confirmation gates (implemented with the SDK's `canUseTool` hook):

| Action | Gate |
|---|---|
| Read-only tools (extract, lint, compare, vault queries, verify, catalog, status) | Auto-allowed |
| `fill_template`, `convert_to_pdf` (produce files) | Show target path, confirm once per session per directory |
| `run` (escape hatch) | Always confirm, showing the exact argv |
| Anything matching a sign subcommand | Hard-refused by the MCP server already; the harness never even prompts |

## 5. Auth & distribution policy

**Design rule: the harness is auth-agnostic and implements no login flow.** It inherits whatever credentials the environment already has, in the SDK's own precedence order.

- **Documented first-class path:** `ANTHROPIC_API_KEY` (pay-per-token). Zero policy ambiguity; required for any commercial/production use.
- **Personal convenience path:** users who already use Claude Code are authenticated via their subscription (`claude setup-token` / existing OAuth). Sanctioned for personal use; as of July 2026, SDK usage draws from normal subscription limits (the announced June-15 billing separation is paused).
- **Policy boundary:** Anthropic does not allow third-party developers to *offer claude.ai login or rate limits* in their products. The harness stays outside this by construction: open-source code, run locally, no credential handling, no marketing of subscription access. Docs are silent on open-source distribution specifically; if certainty is wanted before a public launch, request clarification via Anthropic's contact channel ("unless previously approved" carve-out exists).
- README framing: "bring your own auth" — describe, don't promote, the subscription path.

Sources: Agent SDK quickstart & overview (code.claude.com/docs), help-center article *Use the Claude Agent SDK with your Claude plan*, Anthropic Commercial Terms.

## 6. Signing (explicitly out, with a v1.1 door)

- **v1:** signing is unreachable. The harness ends its loop at "ready for signature" and prints the sign-cli handoff. Post-signature, `verify_signature` / `audit_show` / `contract_vault_due` close the loop.
- **v1.1 (optional, own decision gate):** additionally mount sign-cli's MCP server, whose per-signer single-use approval tokens keep the human gesture outside the agent. This keeps one conversation covering the whole lifecycle without weakening the gate. Not in v1 to keep the trust story simple: *this harness cannot sign, period.*

## 7. Milestones

| # | Milestone | Contents | Est. |
|---|---|---|---|
| M0 | Enclosure spike | SDK session + MCP mount, built-ins disabled; prove the agent cannot touch the filesystem or shell; drive one extract→lint flow | 1–2 days |

**M0 result (2026-07-13): passed.** Spike lives in `~/contract-ops-agent` (`spike.mjs`). Findings that bind M1:

- `disallowedTools: ["*"]` strips MCP tools too (session ends up with zero tools) — the working enclosure is an *explicit* disallow list of built-ins/harness tools + `allowedTools: ["mcp__contract-ops__*"]` + `permissionMode: "dontAsk"`.
- The disallow list is version-brittle, so the harness must **assert at startup** (on the SDK `init` message) that every mounted tool matches `mcp__contract-ops__*` and refuse to start otherwise. This assertion is the real guarantee; the disallow list is just how we satisfy it.
- `strictMcpConfig: true` + the startup assertion also keep out claude.ai MCP connectors (Gmail/Drive/Calendar), which otherwise mount from the operator's logged-in environment.
- Enclosure probe: asked to run shell commands, write files, and read `/etc/hosts`, the agent invoked zero non-MCP tools and correctly explained it has no such capabilities. Extract→lint on a defective fixture used the real CLIs and reported both seeded defects (placeholder, broken xref).
| M1 | Core harness | System prompt (AGENTS.md loop), confirmation gates, streamed terminal UX, session transcript saved locally | 3–5 days |
| M2 | Packaging | `npx contract-ops-agent`, `suite_status` preflight with install hints, README (auth framing per §5), smoke tests | 2–3 days |
| M3 | v1.1 signing door | sign-cli MCP mount behind a flag | separate scope |

**M1 + M2 result (2026-07-13): built and verified as `contract-ops-agent` v0.1.0** (sibling repo `~/contract-ops-agent`; open question §10 resolved in favor of a separate repo). Interactive REPL with streaming-input multi-turn, `canUseTool` gates (read-only auto-allow; fill/convert/run confirm; sign denied; everything else denied), JSONL transcript, npx-ready bin. 18 unit + 7 live tests green. Built per `~/contract-ops-agent/docs/build-plan.md`, which records the full test matrix and the adversarial-review outcome (11 findings fixed).

**Cross-repo finding — fixed, committed (85173ce), tagged v0.1.7, and published to npm 2026-07-13:** an adversarial review of the harness surfaced a real defect in *this* server — `assertSignReadOnly` gated sign *subcommands* but never inspected *flags*, so a state-mutating flag on an otherwise read-only sign subcommand would pass the guard. Fixed by adding a `SIGN_MUTATING_FLAGS` denylist scanned across the whole argv (`--apply`, `--sign`, `--send`, `--approve`, `--token`, `--anchor`, `--force`, `--yes`, key rotation, etc.), so a mutating flag on any sign invocation — allowlisted subcommand or not — is refused. Four unit tests added (`test/unit.mjs`, all 13 green). The harness was already unaffected (it denies `run`+`sign` entirely client-side); this hardens the server's own guarantee.

**Second cross-repo fix — committed (85173ce), released in v0.1.7, published to npm 2026-07-13 — `fill_template`:** a live interactive harness run found the `fill_template` tool broken against the installed `draft-cli 0.9.0`: the handler passed `--params -` (JSON via stdin), which 0.9.0 rejects (`params file not found: -`), and its `.catch()` fallback was dead code (the `cli()` wrapper returns CLI errors rather than throwing). Fixed by writing params to a private temp JSON file and passing `--params <file>` (chosen over the `--<key> value` flag form, which would collide with draft's own flags for a template param named `output`/`syntax`/`json`/etc.); temp dir cleaned up in a `finally`. Added a `fill_template` integration test (`test/integration.mjs`, skips when `draft` absent, green locally). Verified end-to-end through the harness: fill now returns the substituted document. This blocked the harness's entire authoring path until fixed.

*Why a denylist and not a fail-closed read-flag allowlist:* sign-cli was repaired (`npm ci` in `~/Projects/cli-digital-signature-mvp` — its `node_modules` was empty) and its `--catalog json` obtained, but the catalog **under-reports flags** — e.g. `request verify-signed-pdf` *requires* `--request-id` and `--path`, yet both the catalog and `--help` list it as flagless. A fail-closed allowlist built from the catalog would therefore falsely reject the curated `verify_signature` tool's own `--path`. The CLI also silently ignores unrecognized flags, so an unknown flag is not reliably dangerous. The denylist is the sound design here. **Version note:** the reconciliation comment claimed sign-cli 0.6.5, but the linked `sign` bin builds **0.6.0** — comment corrected. Drift check: all allowlisted read subcommands still exist in 0.6.0 and their catalog summaries still declare them read-only (no dangerous drift).

## 8. Risks

- **In-context freelancing shrinks but doesn't vanish:** the model can still *reason* wrongly about a contract it extracted. Mitigation: the loop's lint/compare gates are mandatory before any "ready for signature" verdict, and with no write path, no unaudited artifact can exist.
- **SDK billing/policy drift:** the paused billing change may land; auth-agnostic design means only the README changes.
- **CLI availability:** harness is useless without the suite installed — M2's preflight makes that a guided install, not a crash.
- **Escape-hatch overuse:** if the model routes everything through `run`, the curated ergonomics are lost — the always-confirm gate plus system-prompt routing keeps `run` for the genuine long tail.

## 9. Success criteria

1. From inside the harness there is no sequence of agent actions that modifies a file except via a curated tool, and none that signs anything.
2. Every artifact change is attributable to a specific CLI invocation (argv + exit code) in the session transcript.
3. The AGENTS.md loop happens by default on a realistic task (foreign NDA → extract → review → lint → handoff) with no operator steering.
4. A new user goes from `npx contract-ops-agent` to a completed extract on their own machine in under five minutes.

## 10. Open questions

- **Repo:** new sibling repo (`contract-ops-agent`) vs a workspace inside this one. Leaning new repo — different release cadence, this repo stays a pure MCP server.
- **Name:** ~~`legal-harness` vs `contract-ops-agent` vs something brandable under cli.drbaher.com~~ — resolved: `contract-ops-agent` (published on npm).
- **Transcript format:** plain markdown log vs structured JSONL (feeds a future audit story).
