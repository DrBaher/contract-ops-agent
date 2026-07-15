#!/usr/bin/env node
import readline from "node:readline";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { buildSystemPrompt } from "../src/system-prompt.mjs";
import { Transcript } from "../src/transcript.mjs";
import { preflight, renderPreflight } from "../src/preflight.mjs";
import { startRepl, makeAsker } from "../src/repl.mjs";
import { prepareModel, knownProviderIds } from "../src/providers/index.mjs";
import { configState, configPath, applyAuth, configDir, migrateConfig } from "../src/config.mjs";
import { runSetup } from "../src/setup.mjs";
import { diagnose, renderDoctor, installPlan } from "../src/doctor.mjs";

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`contract-ops-agent — contract work in an enclosure: the agent's only tools are the
contract-ops suite. No shell, no file access, no web, no signing.

Usage:
  contract-ops-agent [--workspace <dir>] [--model <model>]   start the agent (first run: setup wizard)
  contract-ops-agent setup                                   (re)run the setup wizard
  contract-ops-agent doctor                                  check environment; offer to install what's missing

Auth: bring your own — an Anthropic API key, or your existing Claude Code login.`);
  process.exit(0);
}

// A readline-backed prompter for the wizard/doctor (the REPL opens its own).
// Reuses the hardened asker so a closed stdin (EOF / Ctrl-D) yields "" instead
// of throwing ERR_USE_AFTER_CLOSE.
function withAsker(fn) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const mkAsk = makeAsker(rl);
  const ask = async (q) => { const r = await mkAsk(q); return r.closed ? "" : (r.answer ?? ""); };
  // Masked prompt for secrets: print the question, then mute keystroke echo so a
  // pasted key never lands in terminal scrollback. Falls back to plain input if
  // readline's internal writer isn't available.
  const askSecret = async (q) => {
    const orig = rl._writeToOutput;
    if (typeof orig !== "function") return ask(q);
    process.stdout.write(q);
    rl._writeToOutput = () => {};                 // mute the prompt echo + keystrokes
    try {
      const r = await mkAsk("");
      return r.closed ? "" : (r.answer ?? "");
    } finally {
      rl._writeToOutput = orig;
      process.stdout.write("\n");                 // the muted Enter needs a visible newline
    }
  };
  return Promise.resolve(fn(ask, askSecret)).finally(() => { if (!rl.closed) rl.close(); });
}
const runInstall = (cmd) => execSync(cmd, { stdio: "inherit" });

if (sub === "doctor") {
  const migrated = migrateConfig();
  for (const a of migrated.actions) console.log(`[migrated] ${a}`);
  const diag = await diagnose();
  console.log(renderDoctor(diag));
  if (diag.missing.length) {
    await withAsker(async (ask) => {
      const a = (await ask("\nInstall the contract-ops suite now? [y/N] ")).trim();
      if (/^y(es)?$/i.test(a)) runInstall(installPlan(diag.missing).suite);
    });
  }
  process.exit(0);
}

if (sub === "setup") {
  await withAsker((ask, askSecret) => runSetup({ ask, askSecret, checkBin: undefined, runInstall, out: (m) => console.log(m) }));
  console.log(`\nSetup complete. Start the agent with:  contract-ops-agent`);
  console.log(`  (if that's "command not found", you're running from source — use`);
  console.log(`   node bin/contract-ops-agent.mjs, or run \`npm link\` in this repo once`);
  console.log(`   to install the command globally.)`);
  process.exit(0);
}

// Default: start the agent. First run walks the wizard, then drops into the REPL.
// A corrupt config is NOT a first run — never overwrite the user's file.
const cfgState = configState();
if (cfgState.status === "corrupt") {
  console.error(`Your config file has invalid JSON and can't be read:\n  ${configPath()}\n  (${cfgState.error})\nFix the JSON, or delete the file to start fresh with the setup wizard.`);
  process.exit(1);
}
if (cfgState.status === "missing") {
  await withAsker((ask, askSecret) => runSetup({ ask, askSecret, runInstall, out: (m) => console.log(m) }));
  console.log("\nStarting…\n");
}

const cfg = (cfgState.status === "missing" ? configState().config : cfgState.config) ?? {};
applyAuth(cfg);
if (cfg.auth?.mode === "claude-code" && process.env.ANTHROPIC_API_KEY) {
  console.warn("note: ANTHROPIC_API_KEY is set in your environment — it overrides your Claude Code subscription (this bills the API, not your plan). Unset it to use the subscription.");
}
const workspace = resolve(flag("--workspace") ?? cfg.workspace ?? process.cwd());
// prepareModel resolves the ref, loads any setup-stored key into the env, and
// fails fast on a missing key — the same preflight /model switching uses.
let provider, model;
try {
  ({ provider, model } = prepareModel(cfg.model, cfg)); // cfg.model: "provider/model" ref or undefined → claude
} catch (e) {
  console.error(`${e.message}\nEdit ${configPath()} or re-run \`contract-ops-agent setup\`.`);
  process.exit(1);
}
if (flag("--model")) model = flag("--model");

const transcript = new Transcript(join(workspace, "transcripts"));

console.log(renderPreflight(await preflight()));
console.log(`provider:   ${provider.id}`);
console.log(`workspace:  ${workspace}`);
console.log(`transcript: ${transcript.path}`);
console.log(`config:     ${join(configDir(), "config.json")}`);
console.log(`(type /help for commands, /quit to exit)\n`);

await startRepl({
  provider, workspace, model, transcript,
  systemPromptFor: buildSystemPrompt,
  prepare: (ref) => prepareModel(ref, cfg),
  knownProviders: knownProviderIds(cfg),
});
