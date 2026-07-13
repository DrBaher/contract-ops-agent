#!/usr/bin/env node
import { resolve, join } from "node:path";
import { buildOptions } from "../src/options.mjs";
import { makeCanUseTool, newSessionState } from "../src/gates.mjs";
import { SYSTEM_PROMPT } from "../src/system-prompt.mjs";
import { Transcript } from "../src/transcript.mjs";
import { preflight, renderPreflight } from "../src/preflight.mjs";
import { startRepl } from "../src/repl.mjs";

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`legal-harness — contract work in an enclosure: the agent's only tools are the
contract-ops suite. No shell, no file access, no web, no signing.

Usage: legal-harness [--workspace <dir>] [--model <model>]

  --workspace  directory the tools may touch (default: current directory)
  --model      model override (default: SDK default)

Auth: bring your own — ANTHROPIC_API_KEY, or your existing Claude Code login.`);
  process.exit(0);
}

const workspace = resolve(flag("--workspace") ?? process.cwd());
const model = flag("--model");

const transcript = new Transcript(join(workspace, "transcripts"));

console.log(renderPreflight(await preflight()));
console.log(`workspace:  ${workspace}`);
console.log(`transcript: ${transcript.path}`);
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
