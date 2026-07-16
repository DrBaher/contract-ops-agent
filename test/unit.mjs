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

test("U2c: convert_to_pdf confirms per output FILE, not per directory", () => {
  const s = newSessionState();
  const d1 = decide(t("convert_to_pdf"), { input: "out/contract.docx" }, s);
  assert.equal(d1.kind, "confirm");
  assert.match(d1.detail, /out\/contract\.pdf/);
  s.approvals.add(d1.key);
  // same output file (path spellings normalize) → remembered
  assert.equal(decide(t("convert_to_pdf"), { input: "./out/contract.docx" }, s).kind, "allow", "same output normalizes to the same key");
  // a DIFFERENT file in the same dir must re-confirm — approving one write
  // must not auto-allow overwriting a sibling
  assert.equal(decide(t("convert_to_pdf"), { input: "out/other.docx" }, s).kind, "confirm", "different output must re-confirm");
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

test("U3b: run cannot reach signing — denied client-side, evasion-resistant", () => {
  for (const args of [["request", "create"], ["audit", "show"], ["request", "verify-signed-pdf"]]) {
    const d = decide(t("run"), { cli: "sign", args });
    assert.equal(d.kind, "deny", args.join(" "));
    assert.match(d.detail, /human-gated|verify_signature/);
  }
  // casing / whitespace variants must not slip past to a mere y/N confirm
  for (const cli of ["Sign", "SIGN", " sign", "sign "]) {
    assert.equal(decide(t("run"), { cli, args: [] }).kind, "deny", JSON.stringify(cli));
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

  // a config endpoint that SHADOWS a built-in id must error, not silently route
  // to the wrong host (the HIGH audit finding)
  assert.throws(
    () => resolveProvider("openai/x", { providers: { openai: { baseUrl: "https://gw/v1" } } }),
    /collides with the built-in/,
  );
  // empty model segment → undefined (not "")
  assert.equal(modelFromRef("openai/"), undefined);
  // a config entry without a baseUrl is not advertised as available
  try { resolveProvider("mystery", { providers: { half: {} } }); assert.fail("should throw"); }
  catch (e) { assert.doesNotMatch(e.message, /half/); }
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

test("O2: OpenAI driver tolerates malformed / non-object tool arguments (no throw)", async () => {
  const mk = (args) => ({ chat: { completions: { create: async () => ({
    choices: [{ message: { content: "", tool_calls: [
      { id: "x", type: "function", function: { name: "mcp__contract-ops__suite_status", arguments: args } },
    ] } }],
  }) } } });
  for (const args of ["not json{", "\"a string\"", "42", "[1,2]", "null"]) {
    const out = await makeOpenAIDriver(mk(args)).infer({ system: "s", tools: [], messages: [], model: "m" });
    assert.deepEqual(out.toolCalls[0].input, {}, `args ${args} should coerce to {}`);
  }
});

test("O3: OpenAI driver accepts tool_calls that omit `type` (compatible endpoints)", async () => {
  // Gemini/Grok/Ollama-style: tool_calls without a `type` field must still map.
  const client = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: "", tool_calls: [
      { id: "g1", function: { name: "mcp__contract-ops__lint_contract", arguments: '{"path":"x.md"}' } },
    ] } }],
  }) } } };
  const d = makeOpenAIDriver(client);
  const out = await d.infer({ system: "s", tools: [], messages: [], model: "m" });
  assert.deepEqual(out.toolCalls, [{ id: "g1", name: "mcp__contract-ops__lint_contract", input: { path: "x.md" } }]);
  assert.ok(out.assistantMessage.tool_calls, "assistant message keeps its tool_calls when calls were normalized");

  // when NO tool_calls normalize, they're stripped from the assistant message so
  // history doesn't wedge the next request
  const empty = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: "hi", tool_calls: [{ id: "z" /* no function */ }] } }],
  }) } } };
  const out2 = await makeOpenAIDriver(empty).infer({ system: "s", tools: [], messages: [], model: "m" });
  assert.deepEqual(out2.toolCalls, []);
  assert.equal(out2.assistantMessage.tool_calls, undefined);
});

// --- REPL input parsing (Tier-2 UX: /help, unknown commands never reach the model) ---
test("R1: parseReplInput routes commands, prose, and noise correctly", async () => {
  const { parseReplInput } = await import("../src/repl.mjs");
  assert.deepEqual(parseReplInput("review the NDA"), { kind: "send", text: "review the NDA" });
  assert.deepEqual(parseReplInput("  /quit "), { kind: "quit" });
  assert.deepEqual(parseReplInput("/exit"), { kind: "quit" });
  assert.deepEqual(parseReplInput("/q"), { kind: "quit" });
  assert.deepEqual(parseReplInput("/help"), { kind: "help" });
  assert.deepEqual(parseReplInput("/?"), { kind: "help" });
  assert.deepEqual(parseReplInput(""), { kind: "empty" });
  assert.deepEqual(parseReplInput("   "), { kind: "empty" });
  assert.deepEqual(parseReplInput("/nope gpt-4o"), { kind: "unknown", cmd: "/nope" });
  // A path-like leading slash is still a command shape — users must not
  // accidentally send "/etc/hosts" as a command; document the tradeoff:
  assert.equal(parseReplInput("/etc/hosts please").kind, "unknown");
});

test("R2: OpenAI driver normalizes usage for the turn footer", async () => {
  const { makeOpenAIDriver } = await import("../src/providers/openai.mjs");
  const client = { chat: { completions: { create: async () => ({
    choices: [{ message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 120, completion_tokens: 45 },
  }) } } };
  const out = await makeOpenAIDriver(client).infer({ system: "s", tools: [], messages: [], model: "m" });
  assert.deepEqual(out.usage, { input: 120, output: 45 });
});

// --- v0.4 M1: preset endpoints ---
test("P4: preset endpoints resolve with zero config", async () => {
  const { PRESET_ENDPOINTS } = await import("../src/providers/index.mjs");
  const g = resolveProvider("gemini/gemini-2.5-pro");
  assert.equal(g.id, "gemini");
  assert.deepEqual(g.envKeys, ["GEMINI_API_KEY"]);
  assert.equal(g.keyOptional, false);
  assert.equal(modelFromRef("gemini/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(resolveProvider("deepseek").defaultModel, "deepseek-chat");
  const o = resolveProvider("ollama/llama3.3");
  assert.equal(o.keyOptional, true, "local endpoints must not demand a key");
  // every preset id resolves
  for (const id of Object.keys(PRESET_ENDPOINTS)) assert.equal(resolveProvider(id).id, id);
});

test("P5: a config.providers entry overrides a preset (but never a core built-in)", () => {
  const cfg = { providers: { gemini: { baseUrl: "https://my-proxy/v1", apiKeyEnv: "PROXY_KEY" } } };
  const g = resolveProvider("gemini/x", cfg);
  assert.deepEqual(g.envKeys, ["PROXY_KEY"], "custom entry must win over the preset");
  assert.throws(() => resolveProvider("openai", { providers: { openai: { baseUrl: "https://evil/v1" } } }), /collides/);
  // unknown providers list presets in the "have" hint
  assert.throws(() => resolveProvider("nosuch"), /gemini.*ollama|ollama.*gemini/s);
});

test("SP1: buildSystemPrompt — Claude stays lean, loop providers get the tool-use addendum", async () => {
  const { SYSTEM_PROMPT, LOOP_ADDENDUM, buildSystemPrompt } = await import("../src/system-prompt.mjs");
  assert.equal(buildSystemPrompt("claude"), SYSTEM_PROMPT);
  assert.equal(buildSystemPrompt("openai"), SYSTEM_PROMPT + LOOP_ADDENDUM);
  assert.equal(buildSystemPrompt("gemini"), SYSTEM_PROMPT + LOOP_ADDENDUM);
  assert.match(buildSystemPrompt("openai"), /Tool-use discipline/);
  assert.ok(buildSystemPrompt("openai").startsWith(SYSTEM_PROMPT), "addendum must extend, not replace");
});

test("R3: parseReplInput handles /model forms", async () => {
  const { parseReplInput } = await import("../src/repl.mjs");
  assert.deepEqual(parseReplInput("/model"), { kind: "model" });
  assert.deepEqual(parseReplInput("/model openai/gpt-4o"), { kind: "model", ref: "openai/gpt-4o" });
  assert.deepEqual(parseReplInput("/model  gemini "), { kind: "model", ref: "gemini" });
});

test("P6: prepareModel — resolves, loads stored keys, enforces the key preflight", async () => {
  const { prepareModel, knownProviderIds } = await import("../src/providers/index.mjs");
  const { mkdtempSync, rmSync: rm } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { saveApiKey: save } = await import("../src/config.mjs");
  const dir = mkdtempSync(join(td(), "coa-pm-"));
  const env = { XDG_CONFIG_HOME: dir };
  try {
    // claude needs no key; ollama is key-optional
    assert.equal(prepareModel(undefined, null, env).provider.id, "claude");
    assert.equal(prepareModel("ollama/llama3.3", null, env).model, "llama3.3");
    // a keyed provider without a key fails fast
    assert.throws(() => prepareModel("openai/gpt-4o", null, { ...env }), /no API key for "openai"/);
    // a setup-stored key is loaded into the env
    save("GEMINI_API_KEY", "sk-gem", env);
    const e2 = { ...env };
    const r = prepareModel("gemini", null, e2);
    assert.equal(r.model, "gemini-2.5-flash");
    assert.equal(e2.GEMINI_API_KEY, "sk-gem", "stored key must be loaded into the env");
    // known providers include core + presets + config endpoints
    const known = knownProviderIds({ providers: { myllm: { baseUrl: "https://x/v1" } } });
    for (const id of ["claude", "openai", "gemini", "ollama", "myllm"]) assert.ok(known.includes(id), id);
  } finally { rm(dir, { recursive: true, force: true }); }
});

// --- v0.4 M5: direct-CLI passthrough ---
test("T1: runTool — list, unknown tool, read-only runs ungated, consequential gates", async () => {
  const { runTool } = await import("../src/passthrough.mjs");
  const calls = [];
  const fakeMcp = {
    tools: [
      { name: "lint_contract", description: "Lint a contract\nmore" },
      { name: "fill_template", description: "Fill a template" },
    ],
    call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: `${name} ran` }] }; },
    close: async () => {},
  };
  const _connect = async () => fakeMcp;
  const lines = [];
  const out = (s) => lines.push(s);
  const confirms = [];

  // list
  assert.equal(await runTool({ workspace: "/w", name: null, out, _connect }), 0);
  assert.ok(lines.join("\n").includes("lint_contract"));

  // unknown
  assert.equal(await runTool({ workspace: "/w", name: "nope", out, _connect }), 2);

  // read-only: no confirmation asked
  const code = await runTool({
    workspace: "/w", name: "lint_contract", args: { path: "a.md" }, out, _connect,
    confirm: async (...a) => { confirms.push(a); return true; },
  });
  assert.equal(code, 0);
  assert.deepEqual(confirms, [], "read-only tool must not prompt");
  assert.deepEqual(calls.at(-1), { name: "lint_contract", args: { path: "a.md" } });

  // consequential: declined → never called
  const before = calls.length;
  const code2 = await runTool({
    workspace: "/w", name: "fill_template", args: { template: "t.md" }, out, _connect,
    confirm: async () => false,
  });
  assert.equal(code2, 2);
  assert.equal(calls.length, before, "declined tool must not execute");

  // consequential: approved → runs
  const code3 = await runTool({
    workspace: "/w", name: "fill_template", args: { template: "t.md" }, out, _connect,
    confirm: async () => true,
  });
  assert.equal(code3, 0);
  assert.equal(calls.at(-1).name, "fill_template");
});

test("makeAsker resolves closed when stdin ended before the interface existed", async () => {
  const fakeRl = {
    input: { readableEnded: true },
    on() {}, off() {},
    question() { throw new Error("must not arm a question on ended stdin"); },
  };
  const ask = makeAsker(fakeRl);
  assert.deepEqual(await ask("prompt> "), { closed: true });
});

test("V1: VERSION single-sources package.json", async () => {
  const { VERSION } = await import("../src/version.mjs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});

test("U8: usage summary aggregates turns/tools/tokens/cost from transcripts", async () => {
  const { summarizeTranscripts, renderUsage } = await import("../src/usage.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "coa-usage-"));
  try {
    const jl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(dir, "2026-01-01.jsonl"), jl([
      { type: "user", text: "hi" },
      { type: "tool_use", tool: "x" }, { type: "tool_use", tool: "y" },
      { type: "result", usage: { input: 100, output: 20 } },
      { type: "result", cost: 0.05 },
    ]));
    writeFileSync(join(dir, "2026-01-02.jsonl"), jl([
      { type: "model", ref: "openai/gpt-4o" },
      { type: "tool_use", tool: "z" },
      { type: "result", usage: { input: 200, output: 40 } },
    ]));
    const sum = summarizeTranscripts(dir);
    assert.equal(sum.sessions.length, 2);
    assert.equal(sum.totals.sessions, 2);
    assert.equal(sum.totals.turns, 3);
    assert.equal(sum.totals.tools, 3);
    assert.equal(sum.totals.inputTokens, 300);
    assert.equal(sum.totals.outputTokens, 60);
    assert.ok(Math.abs(sum.totals.costUsd - 0.05) < 1e-9);
    assert.deepEqual(sum.sessions[1].models, ["openai/gpt-4o"]);
    const text = renderUsage(sum);
    assert.match(text, /TOTAL \(2 sessions\)/);
    // empty dir → graceful
    const empty = summarizeTranscripts(join(dir, "nope"));
    assert.equal(empty.sessions.length, 0);
    assert.match(renderUsage(empty), /no transcripts yet/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
