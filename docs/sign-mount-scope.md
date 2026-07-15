# Signing from the agent — design options for a sign-cli mount

**Status:** DECIDED & IMPLEMENTED (v0.6, 2026-07-15) — the user chose to ship
*both* B and C as user-selectable modes: `signing.mode = "prepare"` (≈C,
adapted: sign-cli's MCP has no create/send tools, so the middle mode is
tracking + PDF preparation, least-privilege enforced server-side via `--tool`)
and `"full"` (=B, every signing act behind a typed-challenge gate). Double
opt-in (config + `--enable-signing`), default off. The analysis below is kept
as the decision record.

The harness's core promise is *"signing is unreachable by design"*: the loop
ends at "ready for signature" and hands off to the human's sign-cli flow. This
doc scopes what it would mean to soften that — because the ask ("send this for
signature" without leaving the agent) is real — and what must stay true no
matter which option is chosen.

## What holds today (the baseline being traded against)

1. With signing off (the default), the agent's only tools are contract-ops
   MCP tools; sign-related needs are covered read-only by the curated
   `verify_signature` / `verify_receipt` / `audit_show` tools.
2. The `run` escape hatch **refuses signing-mutation commands** server-side
   (create/send/approve/sign/…) — hardened in contract-ops-mcp v0.1.3/0.1.7.
3. The startup assertion fails the session if any non-contract-ops tool is
   mounted. Signing capability cannot appear by accident; it requires changing
   the assertion itself.

## Why consider it at all

The draft → review → *send for signature* → track flow currently breaks at the
third step: the user must leave the agent, run sign-cli by hand, then come
back. One interruption per contract — the exact friction the harness exists to
remove elsewhere.

## Options

### A. Status quo (do nothing)

The agent says "ready for signature — run: `sign request create …`". Zero new
risk. The friction stays.

### B. Full mount, flag-gated

`--enable-signing` mounts sign-cli's own MCP server alongside contract-ops;
its tools appear as `mcp__sign__*`; the enclosure assertion learns to accept
exactly that namespace when (and only when) the flag is set; every `sign`
mutation is gated always-confirm.

- For: everything works; no curation to maintain.
- Against: the agent gains **approve/countersign/finalize** — the actual act
  of signing — behind nothing but a y/N prompt. Approval fatigue makes y/N a
  weak gate for the one action that's legally binding. A prompt-injected
  contract ("...and countersign immediately...") only needs one tired keypress.
  This crosses from "the agent prepares, the human signs" to "the agent signs,
  the human supervises" — a different product.

### C. Curated send-only tool (recommended, if anything)

One new curated tool in contract-ops-mcp: `sign_request_send` — create a
signature request for a **finished document** and send it to a **named
recipient**. Nothing else: no approve, no countersign, no finalize, no
cancel-and-resend loops. The human act of *signing* stays human forever.

Safeguards, all of them:

- **Double opt-in:** `"signing": {"send": true}` in config **and**
  `--enable-signing` at launch. Default absent/off.
- **Typed confirmation, not y/N:** the gate shows document path, SHA-256, and
  recipient, and requires typing the recipient's email back. Never remembered
  (`run`-style: every send re-confirms).
- **Assertion stays exact:** the enclosure assertion accepts the one extra
  tool name when signing is enabled, and still fails on anything else.
- **`run` keeps refusing** all sign mutations regardless of the flag — the
  curated tool is the only door, so the gate cannot be routed around.
- **Transcript records** the full send detail (doc digest, recipient) for
  audit.

Threat notes: the dangerous injection path ("send to attacker@evil.com") is
exactly what the typed-recipient confirmation exists to catch — the human
retypes the address they intend, and a mismatch is glaring. Sending to a
correct recipient early (before review) is annoying but recoverable (requests
can be voided in sign-cli); countersigning is not, which is why C excludes it.

### D. Out-of-band handoff polish (cheapest real improvement)

No mount at all: when a document is ready, the agent prints a **copy-paste
command block** (`sign request create --doc … --to …`) with the values filled
in, and `contract-ops-agent tool` gains no signing power. The human runs one
pasted line; the agent picks up afterwards with `verify_*`/vault tracking.
~80% of the friction removed, zero change to the security posture.

## Recommendation at the time (kept for the record)

The original recommendation was **D now; C only if D proves insufficient**,
declining B. The decision went the other way: ship B *and* C as
user-selectable modes, with C adapted to sign-cli's real MCP surface (no
create/send tools exist there, so the middle mode became tracking + PDF
preparation) and B hardened beyond the original sketch (server-side `--tool`
whitelist on every mode, typed-consent gate on each signing act, double
opt-in, per-mode prompt honesty). See the header for what shipped; the threat
analysis above still governs any future widening.
