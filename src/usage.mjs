import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// Aggregate a workspace's JSONL transcripts into per-session and total usage.
// Reads what the REPL already records: `result` events carry `usage`
// (loop providers: {input,output} tokens) and/or `cost` (Claude: USD), and
// `tool_use` events count executed tools. Pure over a transcript directory.
export function summarizeTranscripts(dir) {
  const sessions = [];
  if (!existsSync(dir)) return { sessions, totals: emptyTotals(), dir };
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const s = { file: basename(name), turns: 0, tools: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: new Set() };
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === "tool_use") s.tools++;
      else if (rec.type === "model" && rec.ref) s.models.add(rec.ref);
      else if (rec.type === "result") {
        s.turns++;
        if (rec.usage) { s.inputTokens += rec.usage.input ?? 0; s.outputTokens += rec.usage.output ?? 0; }
        if (typeof rec.cost === "number") s.costUsd += rec.cost;
      }
    }
    s.models = [...s.models];
    sessions.push(s);
  }
  const totals = sessions.reduce((a, s) => ({
    turns: a.turns + s.turns, tools: a.tools + s.tools,
    inputTokens: a.inputTokens + s.inputTokens, outputTokens: a.outputTokens + s.outputTokens,
    costUsd: a.costUsd + s.costUsd, sessions: a.sessions + 1,
  }), emptyTotals());
  return { sessions, totals, dir };
}

function emptyTotals() { return { sessions: 0, turns: 0, tools: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }; }

export function renderUsage({ sessions, totals, dir }, { limit = 10 } = {}) {
  const lines = [`usage — ${dir}`];
  if (!sessions.length) return `${lines[0]}\n(no transcripts yet)`;
  const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cost = (n) => (n > 0 ? `$${n.toFixed(4)}` : "—");
  const recent = sessions.slice(-limit);
  if (recent.length < sessions.length) lines.push(`(showing the ${recent.length} most recent of ${sessions.length} sessions)`);
  lines.push("");
  lines.push(`${"session".padEnd(30)} ${"turns".padStart(5)} ${"tools".padStart(5)} ${"in".padStart(7)} ${"out".padStart(7)} ${"cost".padStart(9)}`);
  for (const s of recent) {
    lines.push(`${s.file.slice(0, 30).padEnd(30)} ${String(s.turns).padStart(5)} ${String(s.tools).padStart(5)} ${fmtTok(s.inputTokens).padStart(7)} ${fmtTok(s.outputTokens).padStart(7)} ${cost(s.costUsd).padStart(9)}`);
  }
  lines.push("");
  lines.push(`${`TOTAL (${totals.sessions} sessions)`.padEnd(30)} ${String(totals.turns).padStart(5)} ${String(totals.tools).padStart(5)} ${fmtTok(totals.inputTokens).padStart(7)} ${fmtTok(totals.outputTokens).padStart(7)} ${cost(totals.costUsd).padStart(9)}`);
  if (totals.costUsd === 0 && (totals.inputTokens > 0))
    lines.push(`\n(no $ cost recorded — loop providers report tokens, not cost; Claude reports cost.)`);
  return lines.join("\n");
}
