// Failure-path coverage for the loop runtime: transient retries, provider
// errors, interrupts, MCP call/connect failures, history repair, and config
// corruption. Fully offline — the MCP connection and model driver are stubs,
// so these run in CI with no CLIs and no keys.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLoopSession, isTransientError, isAbortError } from "../src/loop.mjs";
import { makeOpenAIDriver } from "../src/providers/openai.mjs";
import { configState, isFirstRun, configPath, loadApiKey } from "../src/config.mjs";
import { PREFIX } from "../src/gates.mjs";

const allowAll = async () => ({ behavior: "allow" });
const LINT = `${PREFIX}lint_contract`;

function fakeMcp({ call } = {}) {
  return {
    tools: [{ name: "lint_contract", description: "lint", inputSchema: { type: "object" } }],
    call: call ?? (async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: async () => {},
  };
}

// A scripted driver: each entry is either a response {text, toolCalls} or a
// function invoked as infer() (to throw / hang).
function scriptedDriver(script) {
  let i = 0;
  const d = {
    calls: 0,
    pushUser(messages, text) { messages.push({ role: "user", content: text }); },
    async infer(opts) {
      d.calls++;
      const step = script[i++] ?? { text: "done", toolCalls: [] };
      if (typeof step === "function") return step(opts);
      return { text: step.text ?? "", toolCalls: step.toolCalls ?? [], assistantMessage: { role: "assistant", content: step.text ?? "", ...(step.tool_calls ? { tool_calls: step.tool_calls } : {}) } };
    },
    toolResultMessages(results) {
      d.lastResults = results;
      return results.map((r) => ({ role: "tool", tool_call_id: r.id, content: String(r.content) }));
    },
  };
  return d;
}

function startSession(driver, opts = {}) {
  return startLoopSession({
    workspace: "/tmp", systemPrompt: "sp", model: "stub",
    canUseTool: allowAll, driver,
    retry: { attempts: 3, baseMs: 1 }, // fast backoff for tests
    _connect: async () => opts.mcp ?? fakeMcp(),
    ...opts,
  });
}

// Advance the generator one turn WITHOUT for-await: breaking out of for-await
// calls gen.return() and would kill the session between turns.
async function drainTurn(gen, collected) {
  for (;;) {
    const { value: ev, done } = await gen.next();
    if (done) return null;
    collected.push(ev);
    if (ev.type === "turn_end") return ev;
  }
}

test("transient inference errors retry with backoff and the turn completes", async () => {
  const e429 = Object.assign(new Error("rate limited"), { status: 429 });
  const driver = scriptedDriver([
    () => { throw e429; },
    () => { throw e429; },
    { text: "recovered" },
  ]);
  const session = startSession(driver);
  const events = [];
  session.send("hi");
  const end = await drainTurn(session.events(), events);
  session.end();

  assert.equal(driver.calls, 3, "should have retried twice");
  assert.equal(events.filter((e) => e.type === "notice" && /retrying/.test(e.text)).length, 2);
  assert.ok(events.some((e) => e.type === "text" && e.text === "recovered"));
  assert.ok(!events.some((e) => e.type === "error"));
  assert.ok(end && !end.meta.error && !end.meta.interrupted);
});

test("a non-transient inference error ends the turn, not the session", async () => {
  const e401 = Object.assign(new Error("invalid api key"), { status: 401 });
  const driver = scriptedDriver([
    () => { throw e401; },
    { text: "second turn works" },
  ]);
  const session = startSession(driver);
  const gen = session.events();

  const events = [];
  session.send("first");
  const end1 = await drainTurn(gen, events);
  assert.equal(driver.calls, 1, "401 must not be retried");
  assert.ok(events.some((e) => e.type === "error" && /inference failed/.test(e.message)));
  assert.equal(end1.meta.error, true);

  // The session survives: a new user turn still gets a response.
  const events2 = [];
  session.send("second");
  const end2 = await drainTurn(gen, events2);
  session.end();
  assert.ok(events2.some((e) => e.type === "text" && /second turn works/.test(e.text)));
  assert.ok(end2 && !end2.meta.error);
});

test("interrupt during inference ends the turn as interrupted, session continues", async () => {
  const driver = scriptedDriver([
    ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })), { once: true });
    }),
    { text: "after interrupt" },
  ]);
  const session = startSession(driver);
  const gen = session.events();
  session.send("long task");
  setTimeout(() => session.interrupt(), 20);
  const events = [];
  const end1 = await drainTurn(gen, events);
  assert.equal(end1.meta.interrupted, true);
  assert.ok(!events.some((e) => e.type === "error"), "interrupt must not surface as an error");

  const events2 = [];
  session.send("next");
  const end2 = await drainTurn(gen, events2);
  session.end();
  assert.ok(events2.some((e) => e.type === "text" && /after interrupt/.test(e.text)));
  assert.ok(end2 && !end2.meta.interrupted);
});

test("an MCP call failure becomes an isError tool result, not a crash", async () => {
  const driver = scriptedDriver([
    { toolCalls: [{ id: "c1", name: LINT, input: { path: "a.md" } }] },
    { text: "saw the failure" },
  ]);
  const session = startSession(driver, {
    mcp: fakeMcp({ call: async () => { throw new Error("MCP server died (EPIPE)"); } }),
  });
  const events = [];
  session.send("lint it");
  const end = await drainTurn(session.events(), events);
  session.end();
  assert.ok(end && !end.meta.error, "turn should complete normally");
  const fed = driver.lastResults.find((r) => r.id === "c1");
  assert.equal(fed.isError, true);
  assert.match(String(fed.content), /tool call failed.*EPIPE/);
  assert.ok(events.some((e) => e.type === "text" && /saw the failure/.test(e.text)));
});

test("MCP connect failure yields a clean error event and ends the session", async () => {
  const session = startLoopSession({
    workspace: "/tmp", systemPrompt: "sp", canUseTool: allowAll,
    driver: scriptedDriver([]),
    _connect: async () => { throw new Error("spawn ENOENT"); },
  });
  session.send("hi");
  const events = [];
  for await (const ev of session.events()) events.push(ev);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].message, /could not start the contract-ops tool server.*ENOENT/);
});

test("maxTurns emits a notice instead of silently truncating", async () => {
  const looping = { toolCalls: [{ id: "x", name: LINT, input: {} }] };
  const driver = scriptedDriver([looping, looping, looping, looping, looping]);
  const session = startSession(driver, { maxTurns: 2 });
  const events = [];
  session.send("go");
  const end = await drainTurn(session.events(), events);
  session.end();
  assert.equal(end.meta.maxTurnsHit, true);
  assert.ok(events.some((e) => e.type === "notice" && /maxTurns/.test(e.text)));
});

test("turn_end meta accumulates usage across a multi-call turn", async () => {
  const driver = scriptedDriver([
    { toolCalls: [{ id: "c1", name: LINT, input: {} }], usage: { input: 100, output: 20 } },
    { text: "done", usage: { input: 150, output: 30 } },
  ]);
  const baseInfer = driver.infer.bind(driver);
  let j = 0;
  const usages = [{ input: 100, output: 20 }, { input: 150, output: 30 }];
  driver.infer = async (opts) => ({ ...(await baseInfer(opts)), usage: usages[j++] });
  const session = startSession(driver);
  const events = [];
  session.send("go");
  const end = await drainTurn(session.events(), events);
  session.end();
  assert.deepEqual(end.meta.usage, { input: 250, output: 50 });
});

test("openai compactHistory trims old messages at a user-message boundary", () => {
  const driver = makeOpenAIDriver(null);
  // 130 messages: repeated [user, assistant(tool_calls), tool, assistant] blocks.
  const messages = [];
  while (messages.length < 130) {
    messages.push({ role: "user", content: `u${messages.length}` });
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `t${messages.length}` }] });
    messages.push({ role: "tool", tool_call_id: `t${messages.length - 1}`, content: "r" });
    messages.push({ role: "assistant", content: "done" });
  }
  const before = messages.length;
  const dropped = driver.compactHistory(messages);
  assert.ok(dropped > 0);
  assert.equal(messages.length, before - dropped);
  assert.ok(messages.length <= 80 + 3, `still ${messages.length} messages`);
  assert.equal(messages[0].role, "user", "compacted history must resume at a user message");
  // Under the threshold nothing is touched.
  const small = [{ role: "user", content: "hi" }];
  assert.equal(driver.compactHistory(small), 0);
  assert.equal(small.length, 1);
});

test("the loop announces context trimming via a notice", async () => {
  const driver = scriptedDriver([{ text: "ok" }]);
  driver.compactHistory = () => 7;
  const session = startSession(driver);
  const events = [];
  session.send("go");
  await drainTurn(session.events(), events);
  session.end();
  assert.ok(events.some((e) => e.type === "notice" && /context trimmed.*7 oldest/.test(e.text)));
});

test("openai repairHistory strips dangling tool_calls after an abnormal turn", () => {
  const driver = makeOpenAIDriver(/* client */ null);
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "x", arguments: "{}" } }] },
  ];
  driver.repairHistory(messages);
  assert.equal(messages[1].tool_calls, undefined);
  // A healthy history is left alone.
  const healthy = [{ role: "user", content: "hi" }, { role: "assistant", content: "done" }];
  driver.repairHistory(healthy);
  assert.equal(healthy.length, 2);
});

test("error classification: transient vs terminal vs abort", () => {
  assert.ok(isTransientError(Object.assign(new Error("x"), { status: 429 })));
  assert.ok(isTransientError(Object.assign(new Error("x"), { status: 503 })));
  assert.ok(isTransientError(Object.assign(new Error("fetch failed"), {})));
  assert.ok(isTransientError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
  assert.ok(!isTransientError(Object.assign(new Error("bad key"), { status: 401 })));
  assert.ok(!isTransientError(Object.assign(new Error("bad request"), { status: 400 })));
  assert.ok(isAbortError(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })));
  assert.ok(isAbortError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
  assert.ok(!isAbortError(Object.assign(new Error("rate limited"), { status: 429 })));
});

test("corrupt config.json is detected, not treated as first run", () => {
  const dir = mkdtempSync(join(tmpdir(), "coa-cfg-"));
  const env = { XDG_CONFIG_HOME: dir };
  try {
    assert.equal(configState(env).status, "missing");
    assert.ok(isFirstRun(env));
    mkdirSync(join(dir, "contract-ops-agent"), { recursive: true });
    writeFileSync(configPath(env), "{ not json", "utf8");
    const st = configState(env);
    assert.equal(st.status, "corrupt");
    assert.ok(st.error);
    assert.ok(!isFirstRun(env), "corrupt config must NOT look like a first run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt credentials.json warns and degrades to no stored key", () => {
  const dir = mkdtempSync(join(tmpdir(), "coa-creds-"));
  const env = { XDG_CONFIG_HOME: dir };
  try {
    mkdirSync(join(dir, "contract-ops-agent"), { recursive: true });
    writeFileSync(join(dir, "contract-ops-agent", "credentials.json"), "{ nope", "utf8");
    const warnings = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { warnings.push(String(s)); return true; };
    try {
      assert.equal(loadApiKey("OPENAI_API_KEY", env), null);
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(warnings.some((w) => /credentials\.json is unreadable/.test(w)), warnings.join(""));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- v0.4 M4: resume ---
test("loadResume extracts seedable turns and the Claude session id", async () => {
  const { loadResume } = await import("../src/transcript.mjs");
  const dir = mkdtempSync(join(tmpdir(), "coa-resume-"));
  try {
    const older = join(dir, "2026-07-01T00-00-00-000Z.jsonl");
    const newer = join(dir, "2026-07-02T00-00-00-000Z.jsonl");
    writeFileSync(older, JSON.stringify({ type: "user", text: "old" }) + "\n");
    writeFileSync(newer, [
      JSON.stringify({ type: "init", tools: ["x"], sessionId: "sess-123" }),
      JSON.stringify({ type: "user", text: "lint the NDA" }),
      JSON.stringify({ type: "tool_use", tool: "mcp__contract-ops__lint_contract", input: {} }),
      JSON.stringify({ type: "assistant", text: "Two findings." }),
      JSON.stringify({ type: "result", usage: { input: 1, output: 2 } }),
      "{ torn line",
    ].join("\n") + "\n");

    const r = loadResume(dir, "last");
    assert.equal(r.file, newer, "last must pick the newest transcript");
    assert.equal(r.sessionId, "sess-123");
    assert.deepEqual(r.seed, [
      { role: "user", text: "lint the NDA" },
      { role: "assistant", text: "Two findings." },
    ]);
    const explicit = loadResume(dir, older);
    assert.equal(explicit.file, older);
    assert.equal(explicit.sessionId, null);
    assert.throws(() => loadResume(join(dir, "nope")), /no transcripts directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a seeded loop session starts with the prior conversation in history", async () => {
  const seen = [];
  const driver = scriptedDriver([{ text: "welcome back" }]);
  driver.seedHistory = (messages, turns) => {
    for (const t of turns) messages.push({ role: t.role, content: t.text });
  };
  const baseInfer = driver.infer.bind(driver);
  driver.infer = async (opts) => { seen.push(...opts.messages); return baseInfer(opts); };
  const session = startLoopSession({
    workspace: "/tmp", systemPrompt: "sp", canUseTool: allowAll, driver,
    seed: [{ role: "user", text: "earlier question" }, { role: "assistant", text: "earlier answer" }],
    _connect: async () => fakeMcp(),
  });
  const events = [];
  session.send("continue");
  await drainTurn(session.events(), events);
  session.end();
  assert.deepEqual(seen.map((m) => m.content), ["earlier question", "earlier answer", "continue"]);
});
