// Signing modes — the ONE deliberate softening of "signing is unreachable".
// Design + threat analysis: docs/sign-mount-scope.md. Everything here is
// double-opt-in: config `signing.mode` AND the --enable-signing launch flag.
//
//   off     (default) sign-cli is not mounted; nothing changes.
//   prepare mounts sign-cli's own MCP server least-privilege (--read-only +
//           --tool whitelist enforced SERVER-side): status/audit/receipt
//           tracking plus PDF preparation (field detection, preview stamps,
//           date fills). The signing ACT does not exist in the session.
//   full    every sign tool, including the signing act (sign / document /
//           signer_decline). Each act requires the human to TYPE a
//           confirmation value at the gate — never y/N, never remembered.

export const SIGN_PREFIX = "mcp__sign__";
export const SIGNING_MODES = ["off", "prepare", "full"];

// Read-only sign tools: no state change, no files written.
export const SIGN_READS = [
  "signer_list", "signer_fetch_document", "request_show", "request_status",
  "request_watch", "request_receipt", "audit_verify", "audit_scan",
  "pdf_detect_signature_field", "pdf_detect_date_field", "pdf_inspect_signatures",
  "profile_list", "profile_show",
];
// Preparation tools that write files (previews, date stamps) — y/N gated.
export const SIGN_PREPARE_WRITES = ["preview", "pdf_stamp_text"];
// The signing act and its siblings — full mode only, typed confirmation.
export const SIGN_ACTS = ["sign", "signer_decline", "document"];
// Token minting: full mode only, y/N gated (recoverable — old token dies).
export const SIGN_TOKEN_OPS = ["signer_reissue_token"];

export function allowedSignTools(mode) {
  if (mode === "prepare") return [...SIGN_READS, ...SIGN_PREPARE_WRITES];
  if (mode === "full") return [...SIGN_READS, ...SIGN_PREPARE_WRITES, ...SIGN_ACTS, ...SIGN_TOKEN_OPS];
  return [];
}

// argv for `sign mcp serve` per mode. BOTH modes pass the --tool whitelist so
// the server only exposes what the mode allows (calls outside it get
// UNKNOWN_TOOL) — least privilege by construction, and the enclosure
// assertion's allowed list can never drift from the mount (a sign-cli upgrade
// that adds tools cannot surprise-fail the session). prepare additionally
// passes --read-only, blocking the signing act server-side.
export function signServeArgs(mode) {
  // --capability tools: advertise ONLY the tools surface, so the mount never
  // exposes sign-cli's MCP resources/prompts (which the Agent SDK would turn
  // into extra resource-reader tools that breach the enclosure assertion).
  const args = ["mcp", "serve", "--capability", "tools"];
  if (mode === "prepare") args.push("--read-only", "true");
  if (mode === "prepare" || mode === "full") {
    for (const t of allowedSignTools(mode)) args.push("--tool", t);
  }
  return args;
}

// Double opt-in. Returns the active mode plus a warning when config asks for
// signing but the launch flag is missing (stays off — fail closed).
export function resolveSigningMode(cfg, argv) {
  const mode = cfg?.signing?.mode ?? "off";
  if (!SIGNING_MODES.includes(mode)) {
    throw new Error(`invalid signing.mode "${mode}" — use off | prepare | full`);
  }
  if (mode === "off") return { mode: "off", warning: null };
  if (!argv.includes("--enable-signing")) {
    return { mode: "off", warning: `signing.mode is "${mode}" in config, but --enable-signing was not passed — signing stays OFF this session.` };
  }
  return { mode, warning: null };
}
