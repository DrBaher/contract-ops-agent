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
  out("  contract-ops-agent");
  out("  A contract assistant that can use ONLY the contract-ops tools — extract,");
  out("  lint, compare, draft, review, convert, the vaults, and signature checks.");
  out("  No shell, no general file access, and it can't sign anything. That limit is");
  out("  the point: it does contract work and nothing else on your machine.");
  out("");
  out("  Three quick steps to get you going.");
  out("");

  // ── Step 1/3 · Environment ──────────────────────────────────────────────
  out("Step 1/3 · Environment");
  out("  The agent works by driving nine small command-line tools — all local, no cloud.");
  const diag = await diagnose({ checkBin, env });
  const okCount = diag.cliRows.length - diag.missing.length;
  if (diag.missing.length === 0) {
    out(`  ✓ all ${diag.cliRows.length} tools installed`);
  } else {
    out(`  ${okCount} of ${diag.cliRows.length} installed — missing: ${diag.missing.map((m) => m.bin).join(", ")}`);
    out("  These are free and install locally (via pip / npm).");
    if (runInstall) {
      const choice = (await ask("  Install them now? [A]ll (recommended) · [c]hoose each · [s]kip: ")).trim().toLowerCase();
      if (choice === "c" || choice === "choose") {
        for (const c of installPlan(diag.missing).perCli) {
          if (yes(await ask(`    install ${c.bin}? [Y/n] `))) await runInstall(c.command);
        }
      } else if (choice === "s" || choice === "skip" || /^n/.test(choice)) {
        out("  Skipped — the tools you didn't install just won't be available yet.");
      } else {
        await runInstall(installPlan(diag.missing).suite); // default / "a" / "all" / "y"
        out("  Installed. (You can re-check any time with:  contract-ops-agent doctor)");
      }
    }
  }
  out(diag.pdfBackend
    ? "  ✓ PDF backend installed (used for DOCX → PDF)"
    : "  ⚠ no PDF backend found — DOCX → PDF won't work until you install LibreOffice");
  out("");

  // ── Step 2/3 · Workspace ────────────────────────────────────────────────
  out("Step 2/3 · Workspace");
  out("  Choose the folder that holds your contracts. The agent can read and write");
  out("  ONLY inside this folder — nothing anywhere else on your computer is reachable.");
  const wsAns = (await ask(`  Folder [${cwd}]: `)).trim();
  const workspace = resolve(wsAns || cwd);
  out("");

  // ── Step 3/3 · Authentication (delegate, never implement claude.ai login) ─
  out("Step 3/3 · Authentication");
  out("  How should the agent reach Claude? (your credentials stay on this machine)");
  let auth;
  if (env.ANTHROPIC_API_KEY && yes(await ask("  Found ANTHROPIC_API_KEY in your environment — use it? [Y/n] "))) {
    auth = { mode: "env" };
  }
  if (!auth) {
    const choice = (await ask(
      "  1) Anthropic API key — paste a key from console.anthropic.com; billed per use.\n" +
      "       Saved on this machine only, owner-readable (chmod 600); sent only to Anthropic.\n" +
      "  2) Claude Code subscription — reuse the login you already have in Claude Code;\n" +
      "       draws on your existing plan, nothing to paste, no separate key.\n" +
      "  Choose [1/2]: ",
    )).trim();
    if (choice === "2") {
      auth = { mode: "claude-code" };
      out("  Great — it'll use your Claude Code login. (Not logged in yet? Run:  claude setup-token)");
    } else {
      const key = (await ask("  Paste your Anthropic API key: ")).trim();
      if (key) { saveApiKey(key, env); auth = { mode: "api-key" }; out("  Saved to ~/.config/contract-ops-agent/credentials.json (chmod 600)."); }
      else { auth = { mode: "env" }; out("  No key entered — it'll read ANTHROPIC_API_KEY from your environment at run time."); }
    }
  }

  const cfg = saveConfig({ workspace, auth }, env);

  // ── Summary ─────────────────────────────────────────────────────────────
  out("");
  out("You're set:");
  out("  provider    Claude");
  out(`  workspace   ${workspace}`);
  out(`  auth        ${authLabel(auth)}`);
  out("");
  out("How to use it: just say what you want in plain language — for example");
  out('    "extract agreement.md and lint it"');
  out('    "fill template.md with client_name Acme and effective_date 2026-09-01"');
  out('    "compare v1.md and v2.md"');
  out("The agent reads files freely, but always asks your OK before it writes");
  out("a file or runs anything beyond a read — and it can never sign on your behalf.");
  return cfg;
}
