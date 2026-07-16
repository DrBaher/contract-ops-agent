// Tool-count ceiling: how many tools can a model tolerate before it stops
// tool-calling? Single-turn — ask the model to lint a file, with N tools in
// context (always including the target lint_contract), and report the hit rate.
// This isolates tool-count from task difficulty; a small local model has a
// hard ceiling well below the full 50-tool surface.
//
//   node eval/tool-ceiling.mjs <model> [points] [trials]
//   node eval/tool-ceiling.mjs qwen2.5:7b 5,17,25,35,50 3   # local via ollama
//   OPENAI_API_KEY=... EVAL_BASE_URL=https://api.openai.com/v1 node eval/tool-ceiling.mjs gpt-4o
import OpenAI from "openai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { makeOpenAIDriver } = await import(join(AGENT, "src/providers/openai.mjs"));
const { connectMcp } = await import(join(AGENT, "src/mcp-client.mjs"));
const { buildSystemPrompt } = await import(join(AGENT, "src/system-prompt.mjs"));
const { PREFIX } = await import(join(AGENT, "src/gates.mjs"));

const model = process.argv[2] || "qwen2.5:7b";
const points = (process.argv[3] || "5,17,25,35,50").split(",").map(Number);
const trials = Number(process.argv[4] || 3);
const baseURL = process.env.EVAL_BASE_URL || "http://localhost:11434/v1"; // default: local ollama

const mcp = await connectMcp("/tmp");
const all = mcp.tools.map((t) => ({ name: PREFIX + t.name, description: t.description, inputSchema: t.inputSchema }));
const lint = all.find((t) => t.name.endsWith("lint_contract"));
const others = all.filter((t) => t !== lint);
const driver = makeOpenAIDriver(new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "none", baseURL }));

console.log(`tool-ceiling · ${model} @ ${baseURL}  (available: ${all.length} tools, ${trials} trials each)`);
for (const n of points) {
  if (n > all.length) continue;
  const tools = [lint, ...others.slice(0, n - 1)]; // always include the target tool
  let hits = 0;
  for (let i = 0; i < trials; i++) {
    try {
      const r = await driver.infer({ system: buildSystemPrompt("openai"), tools, messages: [{ role: "user", content: "Lint agreement.md and list the findings." }], model });
      if (r.toolCalls.some((c) => c.name.endsWith("lint_contract"))) hits++;
    } catch { /* miss */ }
  }
  console.log(`  ${String(n).padStart(3)} tools → lint_contract called ${hits}/${trials}`);
}
await mcp.close();
process.exit(0);
