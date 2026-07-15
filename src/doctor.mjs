import { CLIS } from "contract-ops-mcp/contract-ops-mcp.mjs";
import { preflight, defaultCheckBin } from "./preflight.mjs";
import { loadConfig, loadApiKey } from "./config.mjs";
import { resolveProvider } from "./providers/index.mjs";
import { SIGNING_MODES } from "./signing.mjs";

export const SUITE_INSTALLER = "curl -fsSL https://cli.drbaher.com/install.sh | sh";
const PDF_BINS = ["soffice", "libreoffice"];

// Environment report — pure over an injected bin-checker and env, so tests
// don't touch the real PATH.
export async function diagnose({ clis = CLIS, checkBin = defaultCheckBin, env = process.env } = {}) {
  const cliRows = await preflight(clis, checkBin);
  const missing = cliRows.filter((r) => !r.installed);
  let pdfBackend = false;
  for (const b of PDF_BINS) if (await checkBin(b)) { pdfBackend = true; break; }
  const cfg = loadConfig(env);
  // Auth is checked against the CONFIGURED provider's key vars, not a
  // hardcoded ANTHROPIC_API_KEY — an openai/custom config needs its own key.
  let provider = null;
  let providerError = null;
  try { provider = resolveProvider(cfg?.model, cfg); } catch (e) { providerError = e.message; }
  const keyEnvVars = provider?.envKeys ?? [];
  // Signing config: validate the mode and, when one is set, that sign-cli is
  // actually installed (its MCP server is the mount).
  const signingMode = cfg?.signing?.mode ?? "off";
  const signing = {
    mode: signingMode,
    valid: SIGNING_MODES.includes(signingMode),
    signBin: signingMode !== "off" && SIGNING_MODES.includes(signingMode) ? await checkBin("sign") : null,
  };
  // Fallback refs: resolve each and check its key NOW — a typo'd or keyless
  // fallback otherwise only surfaces mid-session, at the worst moment.
  const fallbacks = (Array.isArray(cfg?.fallbacks) ? cfg.fallbacks : []).map((ref) => {
    try {
      const p = resolveProvider(ref, cfg);
      const keyOk = p.id === "claude" || p.keyOptional === true || p.envKeys.some((k) => !!env[k] || !!loadApiKey(k, env));
      return { ref, ok: keyOk, problem: keyOk ? null : `no key (${p.envKeys.join("/")})` };
    } catch (e) {
      return { ref, ok: false, problem: e.message };
    }
  });
  return {
    cliRows,
    missing,
    pdfBackend,
    provider: cfg?.model ?? null,
    providerId: provider?.id ?? null,
    providerError,
    signing,
    fallbacks,
    auth: {
      configured: cfg?.auth?.mode ?? null,
      envKey: cfg?.auth?.envKey ?? null,
      keyEnvVars,
      keyInEnv: keyEnvVars.filter((k) => !!env[k]),
      keyStored: keyEnvVars.filter((k) => !!loadApiKey(k, env)),
      claudeCodeToken: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    },
  };
}

// What to run to install the missing pieces. Pure — no execution here.
export function installPlan(missing, { suiteInstaller = SUITE_INSTALLER } = {}) {
  return {
    suite: suiteInstaller,
    perCli: missing.map((m) => ({ cli: m.cli, bin: m.bin, command: m.install })),
  };
}

export function renderDoctor(diag) {
  const lines = [];
  const okCount = diag.cliRows.length - diag.missing.length;
  lines.push(`CLIs:        ${okCount}/${diag.cliRows.length} installed`);
  for (const m of diag.missing) lines.push(`  missing ${m.bin.padEnd(16)} install: ${m.install}`);
  lines.push(`PDF backend: ${diag.pdfBackend ? "present" : "MISSING (convert_to_pdf needs LibreOffice/soffice)"}`);
  if (diag.providerError) {
    lines.push(`Provider:    INVALID — ${diag.providerError}`);
    lines.push(`Auth:        unknown (fix the provider first)`);
    return lines.join("\n");
  }
  lines.push(`Provider:    ${diag.provider ?? "not configured (defaults to claude)"}`);
  const a = diag.auth;
  let authState;
  if (a.keyInEnv.length) authState = `${a.keyInEnv[0]} present in env`;
  else if (a.keyStored.length) authState = `${a.keyStored[0]} stored by setup`;
  else if (diag.providerId === "claude" && (a.configured === "claude-code" || a.claudeCodeToken)) authState = "Claude Code login";
  else if (diag.providerId === "claude") authState = "no key found — the Agent SDK will try your Claude Code login (or run `contract-ops-agent setup`)";
  else authState = `NOT configured — no ${a.keyEnvVars.join("/")} in env or stored; run \`contract-ops-agent setup\``;
  lines.push(`Auth:        ${authState}`);
  const sg = diag.signing;
  if (sg) {
    if (!sg.valid) lines.push(`Signing:     INVALID mode "${sg.mode}" — use off | prepare | full`);
    else if (sg.mode === "off") lines.push(`Signing:     off`);
    else if (sg.signBin === false) lines.push(`Signing:     ${sg.mode} (config) — but sign-cli is MISSING; install it or set signing.mode to off`);
    else lines.push(`Signing:     ${sg.mode} (config) — activates when you launch with --enable-signing`);
  }
  if (diag.fallbacks?.length) {
    const bad = diag.fallbacks.filter((f) => !f.ok);
    lines.push(bad.length
      ? `Fallbacks:   PROBLEMS — ${bad.map((f) => `${f.ref}: ${f.problem}`).join("; ")}`
      : `Fallbacks:   ${diag.fallbacks.map((f) => f.ref).join(" → ")} (all resolvable)`);
  }
  return lines.join("\n");
}
