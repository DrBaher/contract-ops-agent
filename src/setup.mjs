import { resolve } from "node:path";
import { saveConfig, saveApiKey } from "./config.mjs";
import { diagnose, installPlan } from "./doctor.mjs";

const yes = (s, dflt = true) => {
  const t = String(s ?? "").trim();
  if (!t) return dflt;
  return /^y(es)?$/i.test(t);
};

function authLabel(auth) {
  switch (auth.mode) {
    case "api-key": return "Anthropic API key (stored locally)";
    case "claude-code": return "Claude Code subscription";
    case "env": return "ANTHROPIC_API_KEY from the environment";
    default: return auth.mode;
  }
}

// The guided first-run wizard (our `openclaw onboard`). `ask(question) ->
// Promise<string>` is injected so tests drive it with scripted answers;
// `checkBin` and `runInstall` are injected so tests never touch PATH or run real
// installs. `out` receives the human-facing narration (no-op in tests). Writes
// config + (optionally) the 0600 credentials file, and returns the saved config.
export async function runSetup({ ask, env = process.env, cwd = process.cwd(), checkBin, runInstall, out = () => {} }) {
  out("");
  out("  contract-ops-agent — contract work in an enclosure.");
  out("  Its only tools are the contract-ops suite: no shell, no files, no signing.");
  out("");

  // ── Step 1/3 · Environment ──────────────────────────────────────────────
  out("Step 1/3 · Environment");
  const diag = await diagnose({ checkBin, env });
  const okCount = diag.cliRows.length - diag.missing.length;
  if (diag.missing.length === 0) {
    out(`  ✓ all ${diag.cliRows.length} contract-ops CLIs present`);
  } else {
    out(`  ${okCount}/${diag.cliRows.length} CLIs present — missing: ${diag.missing.map((m) => m.bin).join(", ")}`);
    if (runInstall) {
      const choice = (await ask("  Install? [A]ll · [c]hoose · [s]kip: ")).trim().toLowerCase();
      if (choice === "c" || choice === "choose") {
        for (const c of installPlan(diag.missing).perCli) {
          if (yes(await ask(`    install ${c.bin}? [Y/n] `))) await runInstall(c.command);
        }
      } else if (choice === "s" || choice === "skip" || /^n/.test(choice)) {
        out("  Skipped — those tools stay unavailable until installed.");
      } else {
        await runInstall(installPlan(diag.missing).suite); // default / "a" / "all" / "y"
        out("  Installed. (Run `contract-ops-agent doctor` any time to re-check.)");
      }
    }
  }
  out(diag.pdfBackend
    ? "  ✓ PDF backend present"
    : "  ⚠ no PDF backend (LibreOffice) — convert_to_pdf will be unavailable");
  out("");

  // ── Step 2/3 · Workspace ────────────────────────────────────────────────
  out("Step 2/3 · Workspace");
  const wsAns = (await ask(`  Directory the tools may touch [${cwd}]: `)).trim();
  const workspace = resolve(wsAns || cwd);
  out("");

  // ── Step 3/3 · Authentication (delegate, never implement claude.ai login) ─
  out("Step 3/3 · Authentication");
  let auth;
  if (env.ANTHROPIC_API_KEY && yes(await ask("  ANTHROPIC_API_KEY is already set — use it? [Y/n] "))) {
    auth = { mode: "env" };
  }
  if (!auth) {
    const choice = (await ask(
      "  1) Anthropic API key (stored locally, 0600)\n" +
      "  2) Claude Code subscription (uses your existing Claude Code login)\n" +
      "  Choose [1/2]: ",
    )).trim();
    if (choice === "2") {
      auth = { mode: "claude-code" };
      out("  Using your Claude Code login. If you're not logged in yet, run:  claude setup-token");
    } else {
      const key = (await ask("  Paste your Anthropic API key: ")).trim();
      if (key) { saveApiKey(key, env); auth = { mode: "api-key" }; }
      else { auth = { mode: "env" }; out("  No key entered — will read ANTHROPIC_API_KEY from the environment."); }
    }
  }

  const cfg = saveConfig({ workspace, auth }, env);

  // ── Summary ─────────────────────────────────────────────────────────────
  out("");
  out("You're set:");
  out("  provider    Claude");
  out(`  workspace   ${workspace}`);
  out(`  auth        ${authLabel(auth)}`);
  return cfg;
}
