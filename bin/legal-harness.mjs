#!/usr/bin/env node
import readline from "node:readline";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { buildOptions } from "../src/options.mjs";
import { makeCanUseTool, newSessionState } from "../src/gates.mjs";
import { SYSTEM_PROMPT } from "../src/system-prompt.mjs";
import { Transcript } from "../src/transcript.mjs";
import { preflight, renderPreflight } from "../src/preflight.mjs";
import { startRepl, makeAsker } from "../src/repl.mjs";
import { isFirstRun, loadConfig, applyAuth, configDir } from "../src/config.mjs";
import { runSetup } from "../src/setup.mjs";
import { diagnose, renderDoctor, installPlan } from "../src/doctor.mjs";

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`legal-harness — contract work in an enclosure: the agent's only tools are the
contract-ops suite. No shell, no file access, no web, no signing.

Usage:
  legal-harness [--workspace <dir>] [--model <model>]   start the agent (first run: setup wizard)
  legal-harness setup                                   (re)run the setup wizard
  legal-harness doctor                                  check environment; offer to install what's missing

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
  return Promise.resolve(fn(ask)).finally(() => { if (!rl.closed) rl.close(); });
}
const runInstall = (cmd) => execSync(cmd, { stdio: "inherit" });

if (sub === "doctor") {
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
  await withAsker((ask) => runSetup({ ask, checkBin: undefined, runInstall, out: (m) => console.log(m) }));
  console.log(`\nDone. Run \`legal-harness\` to start.`);
  process.exit(0);
}

// Default: start the agent. First run walks the wizard, then drops into the REPL.
if (isFirstRun()) {
  console.log("First run — let's get you set up.\n");
  await withAsker((ask) => runSetup({ ask, runInstall, out: (m) => console.log(m) }));
  console.log("");
}

const cfg = loadConfig() ?? {};
applyAuth(cfg);
const workspace = resolve(flag("--workspace") ?? cfg.workspace ?? process.cwd());
const model = flag("--model") ?? cfg.model;

const transcript = new Transcript(join(workspace, "transcripts"));

console.log(renderPreflight(await preflight()));
console.log(`workspace:  ${workspace}`);
console.log(`transcript: ${transcript.path}`);
console.log(`config:     ${join(configDir(), "config.json")}`);
console.log(`(type /quit to exit)\n`);

const session = newSessionState();

await startRepl({
  transcript,
  options: (gatePrompter) =>
    buildOptions({
      workspace,
      model,
      systemPrompt: SYSTEM_PROMPT,
      canUseTool: makeCanUseTool(session, gatePrompter, (e) => transcript.write(e)),
    }),
});
