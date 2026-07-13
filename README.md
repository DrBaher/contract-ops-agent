# legal-harness

A terminal agent for contract work, in an **enclosure**: the agent's only tools
are the [contract-ops](https://cli.drbaher.com/) suite, exposed through
`contract-ops-mcp`. No shell, no filesystem access, no web, no signing — not by
policy but by construction. If a request can't be served by extract, lint,
compare, fill, convert, review, the vaults, or verify, the agent literally has
no way to do it.

Scope and rationale: `contract-ops-mcp/docs/legal-harness-scope.md` (Tier 3).

## Install & run

```bash
npm install
node bin/legal-harness.mjs          # first run: a one-time setup wizard, then the REPL
```

The **first run** walks a short wizard — it checks which contract-ops CLIs are
installed (and offers to install any that are missing), picks your workspace
directory, and sets up auth — then drops you into the agent. Every later run
goes straight to the REPL. Config is saved under
`~/.config/legal-harness/` (any secret lives in a separate `0600` file, never in
`config.json` or a transcript).

```
legal-harness [--workspace <dir>] [--model <model>]   start the agent
legal-harness setup                                   (re)run the setup wizard
legal-harness doctor                                  check environment; offer to install what's missing
```

In the REPL, type contract requests; `/quit` to exit; Ctrl-C interrupts the
current turn, twice to exit.

The contract-ops CLIs must be installed (the MCP server shells out to them);
`doctor` and the first-run wizard tell you which are missing and can install them.

## Auth — bring your own

The harness runs on the Claude Agent SDK and uses whatever credentials your
environment already has, in the SDK's own precedence order:

- **`ANTHROPIC_API_KEY`** — the documented path; pay-per-token.
- **Your existing Claude Code login** — if you already use Claude Code, the SDK
  inherits that session. Sanctioned for personal use; it draws from your normal
  subscription limits.

The harness implements no login flow of its own and never handles your
credentials.

## The enclosure (three layers)

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

**Signing** is unreachable here by design — the loop ends at "ready for
signature" and hands off to the human's sign-cli flow.

Every tool call, gate decision, and result is recorded to a JSONL transcript
under `transcripts/` (git-ignored).

## Tests

```bash
npm test         # unit — offline, no API usage
npm run test:live  # integration — real SDK sessions + real CLIs (uses your quota)
npm run spike    # the original M0 enclosure spike
```
