import { resolve } from "node:path";
import { saveConfig, saveApiKey } from "./config.mjs";
import { diagnose, installPlan } from "./doctor.mjs";
import { RESERVED_PROVIDER_IDS, PRESET_ENDPOINTS } from "./providers/index.mjs";

const yes = (s, dflt = true) => {
  const t = String(s ?? "").trim();
  if (!t) return dflt;
  return /^y(es)?$/i.test(t);
};

function authLabel(auth) {
  switch (auth.mode) {
    case "api-key": return "API key (stored locally)";
    case "claude-code": return "Claude Code subscription";
    case "env": return `key from the environment (${auth.envKey})`;
    default: return auth.mode;
  }
}

function providerLabel(model) {
  if (!model || model === "claude") return "Claude";
  if (model.startsWith("openai/")) return `OpenAI (${model.slice("openai/".length)})`;
  return model;
}

// The guided first-run wizard (our `openclaw onboard`). `ask(question) ->
// Promise<string>` is injected so tests drive it with scripted answers;
// `checkBin` and `runInstall` are injected so tests never touch PATH or run real
// installs. `out` receives the human-facing narration (no-op in tests). Writes
// config + (optionally) the 0600 credentials file, and returns the saved config.
export async function runSetup({ ask, askSecret = ask, env = process.env, cwd = process.cwd(), checkBin, runInstall, out = () => {} }) {
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

  // ── Step 3/3 · Model & Authentication (credentials stay on this machine) ──
  out("Step 3/3 · Model & Authentication");
  out("  Which model provider should drive the agent?");
  const pChoice = (await ask(
    "  1) Anthropic Claude — a Claude API key, or your existing Claude Code subscription\n" +
    "  2) OpenAI (GPT)     — your OpenAI API key\n" +
    "  3) Gemini / Grok / DeepSeek / OpenRouter / Ollama — built-in endpoints, just add a key\n" +
    "  4) Other endpoint   — any other OpenAI-compatible API (a proxy, a local server…)\n" +
    "  Choose [1/2/3/4]: ",
  )).trim();

  let model, auth, providers;
  if (pChoice === "3") {
    // A preset endpoint — the base URL and key variable are built in.
    let name = (await ask(`  Which one? [${Object.keys(PRESET_ENDPOINTS).join("/")}]: `)).trim().toLowerCase();
    if (!PRESET_ENDPOINTS[name]) {
      out(`  "${name}" isn't a preset — using gemini. (Presets: ${Object.keys(PRESET_ENDPOINTS).join(", ")}; anything else via option 4.)`);
      name = "gemini";
    }
    const preset = PRESET_ENDPOINTS[name];
    const envKey = preset.apiKeyEnv;
    if (env[envKey] && yes(await ask(`  Found ${envKey} in your environment — use it? [Y/n] `))) {
      auth = { mode: "env", envKey };
    } else {
      const key = (await askSecret(`  API key for ${name} (${preset.keyOptional ? "blank if it needs none" : `stored as ${envKey}`}): `)).trim();
      if (key) { auth = { mode: "api-key", envKey }; saveApiKey(envKey, key, env); out("  Saved (chmod 600)."); }
      else { auth = { mode: "env", envKey }; if (!preset.keyOptional) out(`  No key entered — it'll read ${envKey} from your environment.`); }
    }
    const m = (await ask(`  Model${preset.defaultModel ? ` [${preset.defaultModel}]` : ""}: `)).trim() || preset.defaultModel || "default";
    model = `${name}/${m}`;
  } else if (pChoice === "4") {
    // Any OpenAI-compatible endpoint — reaches the long tail with one adapter.
    out("  Base-URL examples:");
    out("    Gemini:  https://generativelanguage.googleapis.com/v1beta/openai/");
    out("    Grok:    https://api.x.ai/v1        Ollama (local): http://localhost:11434/v1");
    let name = ((await ask("  A short name for it [custom]: ")).trim() || "custom")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name) name = "custom"; // degenerate input (e.g. all separators) → sane default
    if (RESERVED_PROVIDER_IDS.includes(name)) {
      out(`  "${name}" is a built-in provider name — using "${name}-endpoint" so it doesn't collide.`);
      name = `${name}-endpoint`;
    }
    const baseUrl = (await ask("  Base URL: ")).trim();
    const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    const key = (await askSecret("  API key (blank if the endpoint needs none): ")).trim();
    if (key) { saveApiKey(envKey, key, env); auth = { mode: "api-key", envKey }; out("  Saved (chmod 600)."); }
    else { auth = { mode: "env", envKey }; }
    const m = (await ask("  Model id: ")).trim() || "default";
    providers = { [name]: { baseUrl, apiKeyEnv: envKey } };
    model = `${name}/${m}`;
  } else if (pChoice === "2") {
    // OpenAI — API key only (subscription auth is a Claude-only path).
    const envKey = "OPENAI_API_KEY";
    if (env.OPENAI_API_KEY && yes(await ask("  Found OPENAI_API_KEY in your environment — use it? [Y/n] "))) {
      auth = { mode: "env", envKey };
    } else {
      const key = (await askSecret("  Paste your OpenAI API key: ")).trim();
      if (key) { saveApiKey(envKey, key, env); auth = { mode: "api-key", envKey }; out("  Saved (chmod 600), sent only to OpenAI."); }
      else { auth = { mode: "env", envKey }; out("  No key entered — it'll read OPENAI_API_KEY from your environment."); }
    }
    const m = (await ask("  Model [gpt-4o]: ")).trim() || "gpt-4o";
    model = `openai/${m}`;
  } else {
    // Claude (default) — API key, or the Claude Code subscription login.
    const envKey = "ANTHROPIC_API_KEY";
    model = "claude";
    if (env.ANTHROPIC_API_KEY && yes(await ask("  Found ANTHROPIC_API_KEY in your environment — use it? [Y/n] "))) {
      auth = { mode: "env", envKey };
    } else {
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
        const key = (await askSecret("  Paste your Anthropic API key: ")).trim();
        if (key) { saveApiKey(envKey, key, env); auth = { mode: "api-key", envKey }; out("  Saved (chmod 600)."); }
        else { auth = { mode: "env", envKey }; out("  No key entered — it'll read ANTHROPIC_API_KEY from your environment."); }
      }
    }
  }

  const cfg = saveConfig({ workspace, model, auth, ...(providers ? { providers } : {}) }, env);

  // ── Summary ─────────────────────────────────────────────────────────────
  out("");
  out("You're set:");
  out(`  provider    ${providerLabel(model)}`);
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
