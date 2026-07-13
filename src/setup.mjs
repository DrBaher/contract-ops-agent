import { resolve } from "node:path";
import { saveConfig, saveApiKey } from "./config.mjs";
import { diagnose, installPlan } from "./doctor.mjs";

const yes = (s, dflt = true) => {
  const t = String(s ?? "").trim();
  if (!t) return dflt;
  return /^y(es)?$/i.test(t);
};

// The first-run wizard. `ask(question) -> Promise<string>` is injected so tests
// drive it with scripted answers; `checkBin` and `runInstall` are injected so
// tests never touch PATH or run real installs. Writes config + (optionally) the
// 0600 credentials file, and returns the saved config.
export async function runSetup({ ask, env = process.env, cwd = process.cwd(), checkBin, runInstall, out = () => {} }) {
  // 1. Environment doctor + optional install of missing CLIs.
  const diag = await diagnose({ checkBin, env });
  if (diag.missing.length) {
    out(`Missing ${diag.missing.length} of ${diag.cliRows.length} CLIs: ${diag.missing.map((m) => m.bin).join(", ")}`);
    if (runInstall && yes(await ask("Install the contract-ops suite now? [Y/n] "))) {
      await runInstall(installPlan(diag.missing).suite);
    }
  }
  if (!diag.pdfBackend) {
    out("Note: no PDF backend (LibreOffice/soffice) found — convert_to_pdf stays unavailable until one is installed.");
  }

  // 2. Workspace.
  const wsAns = (await ask(`Workspace directory [${cwd}]: `)).trim();
  const workspace = resolve(wsAns || cwd);

  // 3. Auth — delegate, never implement claude.ai login.
  let auth;
  if (env.ANTHROPIC_API_KEY && yes(await ask("ANTHROPIC_API_KEY is already set — use it? [Y/n] "))) {
    auth = { mode: "env" };
  }
  if (!auth) {
    const choice = (await ask(
      "Authenticate with:\n" +
      "  1) Anthropic API key (stored locally, 0600)\n" +
      "  2) Claude Code subscription (uses your existing Claude Code login)\n" +
      "Choose [1/2]: ",
    )).trim();
    if (choice === "2") {
      auth = { mode: "claude-code" };
      out("Using your Claude Code login. If you're not logged in yet, run:  claude setup-token");
    } else {
      const key = (await ask("Paste your Anthropic API key: ")).trim();
      if (key) { saveApiKey(key, env); auth = { mode: "api-key" }; }
      else { auth = { mode: "env" }; out("No key entered — will read ANTHROPIC_API_KEY from the environment at runtime."); }
    }
  }

  // 4. Persist (secret, if any, already went to credentials.json — never here).
  const cfg = saveConfig({ workspace, auth }, env);
  out("Saved configuration.");
  return cfg;
}
