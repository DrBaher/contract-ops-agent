// Raw-loop integration: drives the REAL MCP tools through loop.mjs with a
// STUBBED model driver — proving the enclosure, gate, and tool execution of the
// non-Claude path without needing any model API key. (Needs the contract-ops
// CLIs; skips gracefully otherwise.)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startLoopSession } from "../src/loop.mjs";
import { makeCanUseTool, newSessionState, PREFIX } from "../src/gates.mjs";

const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), "..", "workspace");

let lintAvailable = false;
try { execFileSync("contract-lint", ["--version"], { stdio: "ignore" }); lintAvailable = true; } catch { /* skip */ }
const skip = lintAvailable ? false : "contract-lint not installed";

// A scripted model: each entry is one inference response (text + tool calls).
function stubDriver(script) {
  let i = 0;
  const toolResultsSeen = [];
  return {
    toolResultsSeen,
    pushUser(messages, text) { messages.push({ role: "user", content: text }); },
    async infer() {
      const turn = script[i++] ?? { text: "done", toolCalls: [] };
      return { text: turn.text ?? "", toolCalls: turn.toolCalls ?? [], assistantMessage: { role: "assistant", _turn: i } };
    },
    toolResultMessages(results) {
      toolResultsSeen.push(...results);
      return results.map((r) => ({ role: "tool", tool_call_id: r.id, content: String(r.content) }));
    },
  };
}

async function drain(session, sendText) {
  const events = [];
  session.send(sendText);
  for await (const ev of session.events()) {
    events.push(ev);
    if (ev.type === "turn_end") break;
  }
  session.end();
  return events;
}

test("loop exposes only prefixed contract-ops tools and executes a real one via the gate", { skip }, async () => {
  const driver = stubDriver([
    { toolCalls: [{ id: "c1", name: `${PREFIX}lint_contract`, input: { path: "agreement.md" } }] },
    { text: "Two findings." },
  ]);
  const gateEvents = [];
  const session = startLoopSession({
    workspace: WORKSPACE, systemPrompt: "sp", model: "stub",
    canUseTool: makeCanUseTool(newSessionState(), async () => true, (e) => gateEvents.push(e)),
    driver,
  });
  const events = await drain(session, "lint agreement.md");

  const enclosure = events.find((e) => e.type === "enclosure");
  assert.ok(enclosure, "no enclosure event");
  assert.equal(enclosure.tools.length, 17);
  assert.ok(enclosure.tools.every((n) => n.startsWith(PREFIX)), "a non-contract-ops tool was exposed");

  const toolUse = events.find((e) => e.type === "tool_use");
  assert.equal(toolUse.name, `${PREFIX}lint_contract`);

  // The REAL lint CLI ran: its findings came back to the (stub) model.
  const fed = driver.toolResultsSeen.map((r) => r.content).join("\n");
  assert.match(fed, /placeholder/i);
  assert.match(fed, /broken-xref|cross[- ]?ref/i);

  assert.ok(events.some((e) => e.type === "text" && /findings/i.test(e.text)));
  assert.ok(gateEvents.some((e) => e.behavior === "allow"));
});

test("loop denies a foreign tool by construction — never executed", { skip }, async () => {
  const driver = stubDriver([
    { toolCalls: [{ id: "b1", name: "Bash", input: { command: "rm -rf /" } }] },
    { text: "can't." },
  ]);
  const session = startLoopSession({
    workspace: WORKSPACE, systemPrompt: "sp", model: "stub",
    canUseTool: makeCanUseTool(newSessionState(), async () => true, () => {}),
    driver,
  });
  await drain(session, "run a shell command");
  const denied = driver.toolResultsSeen.find((r) => r.id === "b1");
  assert.ok(denied?.isError, "foreign tool should be refused");
  assert.match(String(denied.content), /enclosure/i);
});

test("loop honors a gate denial on a consequential tool — MCP not called", { skip }, async () => {
  const driver = stubDriver([
    { toolCalls: [{ id: "f1", name: `${PREFIX}fill_template`, input: { template: "template.md" } }] },
    { text: "declined." },
  ]);
  const session = startLoopSession({
    workspace: WORKSPACE, systemPrompt: "sp", model: "stub",
    canUseTool: makeCanUseTool(newSessionState(), async () => false, () => {}), // decline at the gate
    driver,
  });
  await drain(session, "fill the template");
  const res = driver.toolResultsSeen.find((r) => r.id === "f1");
  assert.ok(res?.isError, "declined tool must return an error result");
  assert.match(String(res.content), /declined|denied|approv/i);
});
