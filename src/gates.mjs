// canUseTool gate policy. `decide` is pure so tests never need a TTY; the
// REPL supplies a readline prompter, tests supply a scripted one.
import { normalize, dirname, basename } from "node:path";
import { SIGN_PREFIX, SIGN_READS, SIGN_PREPARE_WRITES, SIGN_ACTS, allowedSignTools } from "./signing.mjs";

export const PREFIX = "mcp__contract-ops__";

export const READ_ONLY = new Set([
  "extract_contract", "lint_contract", "compare_versions", "review_nda",
  "template_vault_find", "template_vault_get",
  "contract_vault_query", "contract_vault_due", "contract_vault_risk",
  "verify_signature", "verify_receipt", "audit_show",
  "catalog", "suite_status",
]);

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
  if (SIGN_ACTS.includes(short)) {
    // The signing act: TYPED confirmation, never y/N, never remembered. The
    // challenge is the concrete target so the human confirms WHAT they sign.
    const target = String(input.request_id ?? input.requestId ?? input.input ?? input.path ?? "").trim();
    const challenge = target ? basename(target) : short;
    return {
      kind: "confirm", key: null, challenge,
      detail: `${short} — SIGNING ACTION on "${target || "(no target given)"}". Legally meaningful; cannot be undone.`,
    };
  }
  // preview / pdf_stamp_text / signer_reissue_token: mutating but recoverable.
  const what = input.output ?? input.pdf ?? input.input ?? input.request_id ?? "";
  return { kind: "confirm", key: null, detail: `${short} — sign-cli write operation${what ? ` on ${what}` : ""}` };
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
    const dir = normalize(dirname(out));
    const key = `convert:${dir}`;
    if (session.approvals.has(key)) return { kind: "allow", detail: `approved earlier this session for ${dir}/`, key };
    return { kind: "confirm", key, detail: `convert_to_pdf — will write ${out}` };
  }

  if (short === "run") {
    // Signing must stay impossible here (scope §4). The curated verify_* tools
    // cover legitimate read-only sign needs; the raw escape hatch never reaches
    // sign at all — deny client-side, backed by the server's own guard.
    if (input.cli === "sign") {
      return { kind: "deny", detail: "signing is human-gated and unreachable here — use verify_signature / verify_receipt / audit_show for read-only checks, or the human sign-cli flow to sign" };
    }
    return { kind: "confirm", key: null, detail: `run (escape hatch) — ${input.cli} ${renderArgv(input.args)}` };
  }

  // A tool the server added after this harness shipped: confirm, never silently allow.
  return { kind: "confirm", key: null, detail: `${short} — unrecognized contract-ops tool` };
}

// prompter(toolName, input, detail, challenge?) -> Promise<boolean>
// When `challenge` is set (signing acts), the prompter must require the human
// to TYPE that value back — y/N is not sufficient consent for a signature.
export function makeCanUseTool(session, prompter, onEvent = () => {}) {
  return async (toolName, input) => {
    const d = decide(toolName, input, session);
    let outcome;
    if (d.kind === "allow") {
      outcome = { behavior: "allow", updatedInput: input };
    } else if (d.kind === "deny") {
      outcome = { behavior: "deny", message: d.detail };
    } else {
      const approved = await prompter(toolName, input, d.detail, d.challenge);
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
