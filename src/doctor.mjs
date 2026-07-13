import { CLIS } from "contract-ops-mcp/contract-ops-mcp.mjs";
import { preflight, defaultCheckBin } from "./preflight.mjs";
import { loadConfig } from "./config.mjs";

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
  return {
    cliRows,
    missing,
    pdfBackend,
    auth: {
      configured: cfg?.auth?.mode ?? null,
      apiKeyInEnv: !!env.ANTHROPIC_API_KEY,
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
  const a = diag.auth;
  const authState = a.configured
    ? `configured (${a.configured})`
    : a.apiKeyInEnv ? "ANTHROPIC_API_KEY in env" : a.claudeCodeToken ? "Claude Code login" : "NOT configured — run `contract-ops-agent setup`";
  lines.push(`Auth:        ${authState}`);
  return lines.join("\n");
}
