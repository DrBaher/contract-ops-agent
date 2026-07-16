// Cross-model eval: run the core contract-ops workflow against a provider and
// score (a) did it call the right tool, and (b) did it produce a sensible
// answer. Verifies the "bring your own model" claim on real backends — not just
// that the enclosure holds (it does, by construction), but that the model can
// actually drive the tools.
//
// Usage:
//   node eval/cross-model.mjs <provider-ref> [model]
//   OPENAI_API_KEY=... node eval/cross-model.mjs openai gpt-4o
//   node eval/cross-model.mjs ollama qwen2.5:7b        # local, no key
//   node eval/cross-model.mjs claude                    # Claude Code login
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT = join(HERE, "..");
const { prepareModel } = await import(join(AGENT, "src/providers/index.mjs"));
const { makeCanUseTool, newSessionState, PREFIX } = await import(join(AGENT, "src/gates.mjs"));
const { buildSystemPrompt } = await import(join(AGENT, "src/system-prompt.mjs"));
const { assertEnclosure } = await import(join(AGENT, "src/enclosure-assert.mjs"));

const ref = process.argv[2] || "openai/gpt-4o";
const modelOverride = process.argv[3];
const { provider, model } = prepareModel(modelOverride ? `${ref.split("/")[0]}/${modelOverride}` : ref);

// ── fixtures ────────────────────────────────────────────────────────────────
const WS = mkdtempSync(join(tmpdir(), "coa-eval-"));
copyFileSync(join(AGENT, "workspace/template.md"), join(WS, "template.md"));
// a richer agreement so extract yields parties/dates, and a v2 for compare
const AGREEMENT = `MASTER SERVICES AGREEMENT

This Master Services Agreement ("Agreement") is entered into as of March 1, 2026,
by and between Beta LLC, a Delaware limited liability company ("Client"), and
Acme Corporation, a California corporation ("Provider").

1. Term. As described in Section 9, this Agreement is perpetual.
2. Fees. Client shall pay Provider the fees set out in [FEE_SCHEDULE].
3. Governing Law. This Agreement is governed by the laws of the State of Delaware.
`;
writeFileSync(join(WS, "agreement.md"), AGREEMENT);
writeFileSync(join(WS, "agreement-v2.md"), AGREEMENT.replace("perpetual", "for an initial term of three (3) years"));
writeFileSync(join(WS, "nda.md"), AGREEMENT);

// ── scenarios ───────────────────────────────────────────────────────────────
// Each: a prompt, the tool expected, and a content check on the final answer.
const SCENARIOS = [
  { id: "extract", prompt: "Extract agreement.md into structured JSON and tell me the two parties.",
    tool: "extract_contract", answer: /beta llc/i },
  { id: "lint", prompt: "Use the lint_contract tool on agreement.md and list every finding.",
    tool: "lint_contract", answer: /placeholder|xref|cross|fee_schedule|finding/i },
  { id: "compare", prompt: "Use compare_versions on agreement.md and agreement-v2.md and summarize what changed.",
    tool: "compare_versions", answer: /term|three|year|perpetual|chang/i },
  { id: "fill", prompt: 'Fill template.md with client_name "Beta LLC" and effective_date "2026-09-01" and show the result.',
    tool: "fill_template", answer: /beta llc/i },
  { id: "review", prompt: "Review nda.md against the house playbook with review_nda and give the decision.",
    tool: "review_nda", answer: /approve|reject|risk|decision|finding/i },
];

async function runScenario(sc) {
  const session = provider.startSession({
    workspace: WS, systemPrompt: buildSystemPrompt(provider.id), model,
    canUseTool: makeCanUseTool(newSessionState(), async () => true, () => {}),
    maxTurns: 12,
  });
  const events = session.events();
  const tools = [];
  let text = "", verified = false, breach = null;
  session.send(sc.prompt);
  const started = Date.now();
  try {
    for (;;) {
      const { value: ev, done } = await Promise.race([
        events.next(),
        new Promise((r) => setTimeout(() => r({ value: { type: "timeout" }, done: false }), 90_000)),
      ]);
      if (done || ev.type === "timeout") break;
      if (ev.type === "enclosure") { try { assertEnclosure({ tools: ev.tools }); verified = true; } catch (e) { breach = e.message; break; } continue; }
      if (ev.type === "tool_use") tools.push(ev.name.replace(PREFIX, ""));
      else if (ev.type === "text") text += ev.text;
      else if (ev.type === "turn_end") break;
    }
  } finally { try { await session.interrupt(); } catch {} session.end(); }
  const toolOk = tools.includes(sc.tool);
  const answerOk = sc.answer.test(text);
  return { id: sc.id, toolOk, answerOk, pass: toolOk && answerOk && !breach, tools, breach, ms: Date.now() - started };
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`\n== Cross-model eval: ${provider.id}${model ? `/${model}` : ""} ==`);
const results = [];
for (const sc of SCENARIOS) {
  const r = await runScenario(sc);
  results.push(r);
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${sc.id.padEnd(8)} tool:${r.toolOk ? "✓" : "✗"} answer:${r.answerOk ? "✓" : "✗"}  (${(r.ms / 1000).toFixed(1)}s, called: ${r.tools.join(",") || "none"})${r.breach ? ` BREACH:${r.breach}` : ""}`);
}
const pass = results.filter((r) => r.pass).length;
const toolRate = results.filter((r) => r.toolOk).length;
console.log(`\n  score: ${pass}/${results.length} scenarios passed · ${toolRate}/${results.length} correct tool selection`);
rmSync(WS, { recursive: true, force: true });
// machine-readable line for aggregation
console.log(`RESULT ${JSON.stringify({ provider: provider.id, model, pass, total: results.length, toolRate, scenarios: results.map((r) => ({ id: r.id, pass: r.pass })) })}`);
