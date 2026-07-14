import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decide, makeCanUseTool, newSessionState, READ_ONLY, PREFIX } from "../src/gates.mjs";
import { buildOptions, DISALLOWED_TOOLS } from "../src/providers/claude.mjs";
import { mcpServerEnv } from "../src/mcp-client.mjs";
import { makeInputQueue } from "../src/async-queue.mjs";
import { makeOpenAIDriver } from "../src/providers/openai.mjs";
import { resolveProvider, modelFromRef } from "../src/providers/index.mjs";
import { assertEnclosure } from "../src/enclosure-assert.mjs";
import { Transcript } from "../src/transcript.mjs";
import { preflight, renderPreflight } from "../src/preflight.mjs";
import { makeAsker } from "../src/repl.mjs";

const t = (short) => `${PREFIX}${short}`;

// U1 — read-only tools auto-allow
test("U1: every read-only tool allows without prompting", () => {
  for (const short of READ_ONLY) {
    const d = decide(t(short), { path: "x.md" });
    assert.equal(d.kind, "allow", short);
  }
});

// U2 — fill_template / convert_to_pdf confirm + session memory
test("U2: fill_template confirms, memory keyed on template + params", () => {
  const s = newSessionState();
  const first = decide(t("fill_template"), { template: "nda.md", params: { client: "Acme" } }, s);
  assert.equal(first.kind, "confirm");
  assert.match(first.detail, /nda\.md/);
  assert.match(first.detail, /client/);
  s.approvals.add(first.key); // simulate approval
  // same template + same params → remembered
  assert.equal(decide(t("fill_template"), { template: "nda.md", params: { client: "Acme" } }, s).kind, "allow");
  // same template, DIFFERENT params → different content, must re-confirm
  assert.equal(decide(t("fill_template"), { template: "nda.md", params: { client: "Beta" } }, s).kind, "confirm");
  // different template → confirm
  assert.equal(decide(t("fill_template"), { template: "other.md" }, s).kind, "confirm");
  // new session → confirm
  assert.equal(decide(t("fill_template"), { template: "nda.md", params: { client: "Acme" } }, newSessionState()).kind, "confirm");
});

test("U2b: fill_template path spellings normalize to one key", () => {
  const s = newSessionState();
  s.approvals.add(decide(t("fill_template"), { template: "./out/nda.md", params: {} }, s).key);
  assert.equal(decide(t("fill_template"), { template: "out/nda.md", params: {} }, s).kind, "allow");
});

test("U2c: convert_to_pdf confirms with output path, remembers per directory", () => {
  const s = newSessionState();
  const d1 = decide(t("convert_to_pdf"), { input: "out/contract.docx" }, s);
  assert.equal(d1.kind, "confirm");
  assert.match(d1.detail, /out\/contract\.pdf/);
  s.approvals.add(d1.key);
  assert.equal(decide(t("convert_to_pdf"), { input: "out/other.docx" }, s).kind, "allow");
  assert.equal(decide(t("convert_to_pdf"), { input: "./out/third.docx" }, s).kind, "allow", "normalized dir must match");
  assert.equal(decide(t("convert_to_pdf"), { input: "elsewhere/x.docx" }, s).kind, "confirm");
});

test("U2d: convert_to_pdf with no path is denied, mints no key", () => {
  const d = decide(t("convert_to_pdf"), {});
  assert.equal(d.kind, "deny");
  assert.equal(d.key, undefined);
});

// U3 — run always confirms, never remembered, argv boundaries preserved
test("U3: run always confirms with boundary-preserving argv", () => {
  const s = newSessionState();
  const d1 = decide(t("run"), { cli: "lint", args: ["a.md", "--json"] }, s);
  assert.equal(d1.kind, "confirm");
  assert.match(d1.detail, /lint a\.md --json/);
  assert.equal(d1.key, null);
  const d2 = decide(t("run"), { cli: "lint", args: ["a.md", "--json"] }, s);
  assert.equal(d2.kind, "confirm", "run approval must not be remembered");
  // args with whitespace keep their boundaries
  const d3 = decide(t("run"), { cli: "compare", args: ["my file.md", "--json"] });
  assert.match(d3.detail, /"my file\.md"/);
});

test("U3b: run cannot reach signing — denied client-side", () => {
  for (const args of [["request", "create"], ["audit", "show"], ["request", "verify-signed-pdf"]]) {
    const d = decide(t("run"), { cli: "sign", args });
    assert.equal(d.kind, "deny", args.join(" "));
    assert.match(d.detail, /human-gated|verify_signature/);
  }
});

// U4 — deny wall
test("U4: non-contract-ops tools are denied", () => {
  for (const name of ["Bash", "Write", "Read", "mcp__other__x", "", undefined]) {
    const d = decide(name, {});
    assert.equal(d.kind, "deny", String(name));
    assert.match(d.detail, /enclosure/);
  }
});

test("U4b: unknown contract-ops tool confirms, never silently allows", () => {
  assert.equal(decide(t("future_tool"), {}).kind, "confirm");
});

test("U4c: makeCanUseTool maps decisions to SDK behaviors and records events", async () => {
  const events = [];
  const s = newSessionState();
  // scripted prompter: approve everything
  const gate = makeCanUseTool(s, async () => true, (e) => events.push(e));
  assert.equal((await gate(t("lint_contract"), { path: "a.md" })).behavior, "allow");
  assert.equal((await gate(t("run"), { cli: "lint", args: [] })).behavior, "allow");
  assert.equal((await gate("Bash", { command: "ls" })).behavior, "deny");
  const denyGate = makeCanUseTool(newSessionState(), async () => false, (e) => events.push(e));
  const denied = await denyGate(t("fill_template"), { template: "x.md" });
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /declined/);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.behavior), ["allow", "allow", "deny", "deny"]);
});

// U5 — options builder
test("U5: options enforce the enclosure config", () => {
  const opts = buildOptions({ workspace: "/tmp/ws", canUseTool: async () => ({}), systemPrompt: "sp" });
  assert.equal(opts.strictMcpConfig, true);
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.permissionMode, "default");
  assert.ok(!("allowedTools" in opts), "allowedTools would bypass canUseTool");
  assert.deepEqual(opts.disallowedTools, DISALLOWED_TOOLS);
  assert.ok(opts.disallowedTools.includes("Bash") && opts.disallowedTools.includes("Workflow"));
  assert.notDeepEqual(opts.disallowedTools, ["*"]);
  assert.equal(opts.mcpServers["contract-ops"].env.CONTRACT_OPS_MCP_BASE_DIR, "/tmp/ws");
  assert.equal(opts.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.throws(() => buildOptions({}), /workspace/);
});

test("U5b: MCP subprocess env is an allowlist — no harness secrets leak to CLIs", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
  try {
    const env = mcpServerEnv("/tmp/ws");
    assert.equal(env.CONTRACT_OPS_MCP_BASE_DIR, "/tmp/ws");
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "API key must not reach the CLI boundary");
    assert.ok("PATH" in env || process.env.PATH === undefined);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

// U6 — enclosure assertion
test("U6: assertEnclosure passes clean lists, throws on leaks and on empty", () => {
  assert.equal(assertEnclosure({ tools: [t("extract_contract"), t("run")] }), 2);
  assert.throws(() => assertEnclosure({ tools: [t("extract_contract"), "Bash"] }), /Bash/);
  assert.throws(() => assertEnclosure({ tools: [] }), /zero tools/);
  assert.throws(() => assertEnclosure({}), /zero tools/);
});

// U7 — transcript
test("U7: transcript is valid JSONL, lazy, and records gate decisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-tr-"));
  const tr = new Transcript(dir);
  assert.ok(!existsSync(tr.path), "file must not exist before first write");
  tr.write({ type: "user", text: "hi" });
  tr.write({ type: "gate", tool: t("run"), decision: "confirm", behavior: "deny" });
  const lines = readFileSync(tr.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "user");
  assert.equal(lines[1].decision, "confirm");
  assert.ok(lines.every((l) => typeof l.ts === "string"));
  rmSync(dir, { recursive: true, force: true });
});

test("U7b: transcript disables on fs error instead of throwing", () => {
  const tr = new Transcript("/dev/null/cannot-mkdir-here");
  const warnings = [];
  tr._warn = (m) => warnings.push(m);
  assert.doesNotThrow(() => tr.write({ type: "user", text: "x" }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transcript disabled/);
  assert.doesNotThrow(() => tr.write({ type: "user", text: "y" })); // stays disabled, silent
  assert.equal(warnings.length, 1);
});

// U8 — preflight
test("U8: preflight reports installed/missing with install hints", async () => {
  const clis = {
    a: { bin: "present-bin", install: "npm i -g a" },
    b: { bin: "absent-bin", install: "pipx install b" },
  };
  const rows = await preflight(clis, async (bin) => bin === "present-bin");
  assert.deepEqual(rows[0], { cli: "a", bin: "present-bin", installed: true });
  assert.deepEqual(rows[1], { cli: "b", bin: "absent-bin", installed: false, install: "pipx install b" });
  const rendered = renderPreflight(rows);
  assert.match(rendered, /1\/2/);
  assert.match(rendered, /pipx install b/);
});

// bonus: the REPL input queue drains in order and terminates on close
test("input queue preserves order and terminates", async () => {
  const q = makeInputQueue();
  q.push(1); q.push(2);
  const seen = [];
  const consumer = (async () => { for await (const v of q) seen.push(v); })();
  await new Promise((r) => setTimeout(r, 10));
  q.push(3);
  q.close();
  await consumer;
  assert.deepEqual(seen, [1, 2, 3]);
});

// The prompt mutex is the fix for the high-severity readline-contention bug:
// concurrent questions must serialize, and an aborted gate question must resolve
// (not hang) without consuming the answer meant for the next question.
test("makeAsker serializes questions and honors abort", async () => {
  const asked = [];
  const pending = [];
  const fakeRl = {
    on() {}, off() {},
    question(q, opts, cb) {
      const callback = typeof opts === "function" ? opts : cb;
      const signal = typeof opts === "object" ? opts.signal : undefined;
      asked.push(q);
      pending.push({ q, callback, signal });
    },
  };
  const ask = makeAsker(fakeRl);

  const ctl = new AbortController();
  const gateP = ask("gate? ", ctl.signal); // question 1 (abortable)
  const nextP = ask("next> ");             // question 2 (queued behind 1)

  await new Promise((r) => setTimeout(r, 5));
  // Only the first question is live — the second must not be armed concurrently.
  assert.deepEqual(asked, ["gate? "]);

  ctl.abort(); // simulate Ctrl-C cancelling the gate
  assert.deepEqual(await gateP, { aborted: true });

  await new Promise((r) => setTimeout(r, 5));
  // Now the second question runs; answering it must not have been swallowed.
  assert.deepEqual(asked, ["gate? ", "next> "]);
  pending[1].callback("hello");
  assert.deepEqual(await nextP, { answer: "hello" });
});

// Regression: stdin EOF (closed pipe / Ctrl-D) must resolve ask() gracefully,
// never throw ERR_USE_AFTER_CLOSE. This is the bug the interactive smoke found.
test("makeAsker resolves to {closed} on readline close instead of throwing", async () => {
  const listeners = { close: [] };
  const fakeRl = {
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    question() { /* never answers — we close instead */ },
  };
  const ask = makeAsker(fakeRl);
  const p = ask("prompt> ");
  listeners.close.forEach((fn) => fn());       // simulate EOF
  assert.deepEqual(await p, { closed: true });
  // A question issued AFTER close must also resolve closed, not throw.
  assert.deepEqual(await ask("again> "), { closed: true });
});

// --- v0.3 provider abstraction (offline) ---

test("P1: provider registry resolves built-ins, refs, and config endpoints", () => {
  assert.equal(resolveProvider("claude").id, "claude");
  assert.equal(resolveProvider("openai").id, "openai");
  assert.equal(resolveProvider("openai/gpt-4o").id, "openai");
  assert.equal(resolveProvider(undefined).id, "claude");            // default
  assert.equal(modelFromRef("openai/gpt-4o"), "gpt-4o");
  assert.equal(modelFromRef("openai/gpt-4o-mini-2026"), "gpt-4o-mini-2026");
  assert.equal(modelFromRef("claude"), undefined);

  // an OpenAI-compatible endpoint defined in config resolves with no new code
  const cfg = { providers: { gemini: { baseUrl: "https://x/v1", apiKeyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.0" } } };
  const g = resolveProvider("gemini/gemini-2.0", cfg);
  assert.equal(g.id, "gemini");
  assert.equal(g.defaultModel, "gemini-2.0");
  assert.deepEqual(g.envKeys, ["GEMINI_API_KEY"]);

  assert.throws(() => resolveProvider("mystery"), /unknown model provider/);          // no cfg
  assert.throws(() => resolveProvider("mystery", { providers: {} }), /unknown model provider/);
});

test("O1: OpenAI driver maps MCP tools → function tools and normalizes tool calls", async () => {
  // Stub client: echoes back a tool call, so we test the dialect mapping only.
  const seen = {};
  const client = {
    chat: { completions: { create: async (req) => { seen.req = req; return {
      choices: [{ message: { content: "hi", tool_calls: [
        { id: "t1", type: "function", function: { name: "mcp__contract-ops__lint_contract", arguments: '{"path":"a.md"}' } },
      ] } }],
    }; } } },
  };
  const d = makeOpenAIDriver(client);
  const exposed = [{ name: "mcp__contract-ops__lint_contract", description: "lint", inputSchema: { type: "object", properties: { path: { type: "string" } } } }];
  const messages = [];
  d.pushUser(messages, "lint a.md");
  assert.deepEqual(messages[0], { role: "user", content: "lint a.md" });

  const out = await d.infer({ system: "sp", tools: exposed, messages, model: "gpt-4o" });
  // request shape: system prepended, tools as function type
  assert.equal(seen.req.messages[0].role, "system");
  assert.equal(seen.req.tools[0].type, "function");
  assert.equal(seen.req.tools[0].function.name, "mcp__contract-ops__lint_contract");
  assert.deepEqual(seen.req.tools[0].function.parameters, exposed[0].inputSchema);
  // normalized output
  assert.equal(out.text, "hi");
  assert.deepEqual(out.toolCalls, [{ id: "t1", name: "mcp__contract-ops__lint_contract", input: { path: "a.md" } }]);

  // tool results → one role:"tool" message each, error prefixed
  const msgs = d.toolResultMessages([
    { id: "t1", content: "findings...", isError: false },
    { id: "t2", content: "nope", isError: true },
  ]);
  assert.deepEqual(msgs[0], { role: "tool", tool_call_id: "t1", content: "findings..." });
  assert.match(msgs[1].content, /^ERROR: nope/);
});

test("O2: OpenAI driver tolerates malformed tool arguments (no throw)", async () => {
  const client = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: "", tool_calls: [
      { id: "x", type: "function", function: { name: "mcp__contract-ops__suite_status", arguments: "not json{" } },
    ] } }],
  }) } } };
  const out = await makeOpenAIDriver(client).infer({ system: "s", tools: [], messages: [], model: "m" });
  assert.deepEqual(out.toolCalls[0].input, {}); // malformed args → {} rather than a crash
});
