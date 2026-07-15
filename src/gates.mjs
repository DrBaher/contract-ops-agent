// canUseTool gate policy. `decide` is pure so tests never need a TTY; the
// REPL supplies a readline prompter, tests supply a scripted one.
import { normalize } from "node:path";
import { SIGN_PREFIX, SIGN_READS, SIGN_ACTS, allowedSignTools } from "./signing.mjs";

export const PREFIX = "mcp__contract-ops__";

export const READ_ONLY = new Set([
  "extract_contract", "lint_contract", "compare_versions", "review_nda",
  "template_vault_find", "template_vault_get",
  "contract_vault_query", "contract_vault_due", "contract_vault_risk",
  "verify_signature", "verify_receipt", "audit_show",
  "catalog", "suite_status",
  // NDA negotiation — read-only views over a negotiation state file
  "negotiate_status", "negotiate_review", "negotiate_diff", "negotiate_analyze", "negotiate_validate",
  // Template vault — browse/inspect (compose/swap/export write, see NDA_WRITES-style set below)
  "template_vault_list", "template_vault_info", "template_vault_diff", "template_vault_history",
  "template_vault_clauses", "template_vault_clause_library", "template_vault_compare_clauses",
  "template_vault_stats", "template_vault_verify",
  // Contract vault — obligations/reminders/register reads (export writes no file)
  "contract_vault_obligations", "contract_vault_remind", "contract_vault_at_risk",
  "contract_vault_review", "contract_vault_verify", "contract_vault_export",
]);

// NDA tools that WRITE a draft/config file but sign nothing — gated y/N, like
// fill_template/convert_to_pdf. (negotiate_finalize only emits final docs from
// an already-converged state; no new signature is applied.)
const NDA_WRITES = new Set(["nda_setup", "generate_redlines", "draft_nda", "negotiate_finalize"]);

// Vault tools that WRITE — a new template version, a file export, or a change to
// the contract register. Gated y/N. Reads live in READ_ONLY above.
const VAULT_WRITES = new Set([
  "template_vault_compose", "template_vault_swap", "template_vault_export",
  "contract_vault_ingest", "contract_vault_obligation", "contract_vault_accept",
]);

// Negotiation acts that SIGN a round in the state file's hash chain — a binding
// commitment. Gated with the SAME typed-consent discipline as sign-cli acts:
// type the target back, interactive-TTY only, never remembered.
const NEGOTIATE_SIGN_ACTS = new Set(["negotiate_init", "negotiate_counter", "negotiate_accept"]);

export function newSessionState(signingMode = "off") {
  return { approvals: new Set(), signingMode };
}

// Stable fingerprint of fill params so approving one fill doesn't silently
// auto-allow a different fill of the same template with different content.
function paramFingerprint(params = {}) {
  const keys = Object.keys(params).sort();
  return JSON.stringify(keys.map((k) => [k, params[k]]));
}

// Render argv so argument boundaries survive (quote anything with whitespace).
function renderArgv(args) {
  if (!Array.isArray(args)) return String(args ?? "");
  return args.map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a))).join(" ");
}

// The sign-cli input field that names the SUBJECT a tool acts on, in priority
// order. Covers every act/write tool's real MCP param names (verified against
// the live `sign mcp serve` catalog): request-based acts use request_id;
// `document` seals input_path; preview/pdf_stamp_text act on pdf_path. This is
// deliberately the INPUT being signed/stamped, never an out_path/output — the
// challenge must bind to what is consumed, not where the result is written.
// Getting this list wrong silently weakens the typed gate (the challenge would
// collapse to the tool name), so it is the security-critical part.
const SIGN_TARGET_FIELDS = ["request_id", "requestId", "input_path", "pdf_path", "input", "path"];

function signTarget(input) {
  for (const f of SIGN_TARGET_FIELDS) {
    const v = input?.[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// Sign-tool policy (signing modes; see src/signing.mjs). Defense in depth:
// mounting is already mode-restricted server-side, this re-checks at the gate.
function decideSign(short, input, session) {
  const mode = session.signingMode ?? "off";
  if (mode === "off") {
    return { kind: "deny", detail: "signing tools are disabled — enable with signing.mode in config AND --enable-signing at launch" };
  }
  if (!allowedSignTools(mode).includes(short)) {
    return { kind: "deny", detail: `sign tool "${short}" is not available in signing mode "${mode}"` };
  }
  if (SIGN_READS.includes(short)) return { kind: "allow", detail: "read-only" };
  const target = signTarget(input);
  if (SIGN_ACTS.includes(short)) {
    // A signing act with no resolvable target is refused outright — we will not
    // present a meaningless challenge for the most dangerous operation.
    if (!target) {
      return { kind: "deny", detail: `${short} — SIGNING ACTION with NO explicit target given (refusing to bind a blind signature). Provide the document/request explicitly and retry.` };
    }
    // The signing act: TYPED confirmation, never y/N, never remembered,
    // interactive-TTY only (requireInteractive). The challenge is the FULL
    // target, not its basename — a basename collides across directories, so
    // typing it wouldn't bind consent to the specific document/request.
    return {
      kind: "confirm", key: null, challenge: target, requireInteractive: true,
      detail: `${short} — SIGNING ACTION on "${target}". Legally meaningful; cannot be undone.`,
    };
  }
  // preview / pdf_stamp_text / signer_reissue_token: mutating but recoverable.
  return { kind: "confirm", key: null, detail: `${short} — sign-cli write operation${target ? ` on ${target}` : ""}` };
}

export function decide(toolName, input = {}, session = newSessionState()) {
  if (typeof toolName === "string" && toolName.startsWith(SIGN_PREFIX)) {
    return decideSign(toolName.slice(SIGN_PREFIX.length), input, session);
  }
  if (typeof toolName !== "string" || !toolName.startsWith(PREFIX)) {
    return { kind: "deny", detail: `"${toolName}" is outside the contract-ops-agent enclosure — only contract-ops tools exist here` };
  }
  const short = toolName.slice(PREFIX.length);

  if (READ_ONLY.has(short)) return { kind: "allow", detail: "read-only" };

  if (NEGOTIATE_SIGN_ACTS.has(short)) {
    // Signs a negotiation round (a binding commitment) — typed consent, TTY
    // only, never remembered. The challenge is the concrete target: the state
    // file for counter/accept, or the new state path for init.
    const target = String(input.state ?? input.out ?? "").trim();
    if (!target) {
      return { kind: "deny", detail: `${short} — NEGOTIATION SIGNATURE with no state/out target given (refusing a blind commitment). Provide it and retry.` };
    }
    return {
      kind: "confirm", key: null, challenge: target, requireInteractive: true,
      detail: `${short} — NEGOTIATION SIGNATURE on "${target}". Commits/signs a round in the negotiation; not a legal e-signature (that stays with sign-cli).`,
    };
  }

  if (NDA_WRITES.has(short)) {
    const out = input.out ?? input.out_md ?? "";
    return { kind: "confirm", key: null, detail: `${short} — NDA write${out ? ` → ${out}` : ""}${short === "nda_setup" ? " (one-time org policy in the workspace)" : ""}` };
  }

  if (VAULT_WRITES.has(short)) {
    const target = input.as_ref ?? input.target ?? input.output ?? input.file ?? input.deal ?? "";
    return { kind: "confirm", key: null, detail: `${short} — vault write${target ? ` (${target})` : ""}` };
  }

  if (short === "fill_template") {
    if (!input.template) return { kind: "confirm", key: null, detail: "fill_template — missing template path" };
    const key = `fill:${normalize(String(input.template))}:${paramFingerprint(input.params)}`;
    if (session.approvals.has(key)) return { kind: "allow", detail: "same template + params approved earlier this session", key };
    const params = Object.keys(input.params ?? {}).join(", ") || "(none)";
    return { kind: "confirm", key, detail: `fill_template — template: ${input.template}, params: ${params} (filled draft returned in-session; nothing written to disk)` };
  }

  if (short === "convert_to_pdf") {
    const out = input.output || (input.input ? String(input.input).replace(/\.docx$/i, ".pdf") : "");
    if (!out) return { kind: "deny", detail: "convert_to_pdf — no input or output path given" };
    // Key on the exact OUTPUT FILE, not its directory: approving one write must
    // not silently auto-allow overwriting a different file in the same folder.
    const key = `convert:${normalize(String(out))}`;
    if (session.approvals.has(key)) return { kind: "allow", detail: `same output approved earlier this session (${out})`, key };
    return { kind: "confirm", key, detail: `convert_to_pdf — will write ${out}` };
  }

  if (short === "run") {
    // Signing must stay impossible here (scope §4). The curated verify_* tools
    // cover legitimate read-only sign needs; the raw escape hatch never reaches
    // sign at all — deny client-side, backed by the server's own guard.
    // Normalize before the match so "Sign", " sign", or a non-string cli can't
    // slip past the client check down to a mere y/N confirm (the server's exact
    // CLIS enum backstops this, but defense-in-depth shouldn't depend on it).
    const cli = typeof input.cli === "string" ? input.cli.trim().toLowerCase() : String(input.cli);
    if (cli === "sign") {
      return { kind: "deny", detail: "signing is human-gated and unreachable here — use verify_signature / verify_receipt / audit_show for read-only checks, or the human sign-cli flow to sign" };
    }
    return { kind: "confirm", key: null, detail: `run (escape hatch) — ${input.cli} ${renderArgv(input.args)}` };
  }

  // A tool the server added after this harness shipped: confirm, never silently allow.
  return { kind: "confirm", key: null, detail: `${short} — unrecognized contract-ops tool` };
}

// prompter(toolName, input, detail, challenge?, requireInteractive?) -> Promise<boolean>
// When `challenge` is set (signing acts), the prompter must require the human
// to TYPE that value back — y/N is not sufficient consent for a signature —
// and when `requireInteractive` is set it must refuse on non-interactive
// (piped/scripted) input, where "consent" would come from the input stream.
export function makeCanUseTool(session, prompter, onEvent = () => {}) {
  return async (toolName, input) => {
    const d = decide(toolName, input, session);
    let outcome;
    if (d.kind === "allow") {
      outcome = { behavior: "allow", updatedInput: input };
    } else if (d.kind === "deny") {
      outcome = { behavior: "deny", message: d.detail };
    } else {
      const approved = await prompter(toolName, input, d.detail, d.challenge, d.requireInteractive === true);
      if (approved) {
        if (d.key) session.approvals.add(d.key);
        outcome = { behavior: "allow", updatedInput: input };
      } else {
        outcome = { behavior: "deny", message: "The user declined this action at the contract-ops-agent gate. Do not retry it; ask what they'd like instead." };
      }
    }
    onEvent({ type: "gate", tool: toolName, input, decision: d.kind, behavior: outcome.behavior, detail: d.detail });
    return outcome;
  };
}
