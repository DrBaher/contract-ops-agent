// REPL-level integration: fallback chains. Drives startRepl end-to-end with
// fake providers and PassThrough streams — no model, no MCP, fully offline.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { startRepl } from "../src/repl.mjs";
import { makeInputQueue } from "../src/async-queue.mjs";

const TOOLS = ["mcp__contract-ops__lint_contract"];

// A provider whose sessions answer each send with a scripted event list.
// respond(text, turnIndex) -> events (excluding the enclosure event).
function fakeProvider(id, respond) {
  const provider = {
    id,
    envKeys: [],
    keyOptional: true,
    defaultModel: "m",
    sessions: [],
    startSession(opts) {
      const inbox = makeInputQueue();
      const sess = {
        opts,
        sent: [],
        send(t) { sess.sent.push(t); inbox.push(t); },
        end() { inbox.close(); },
        async interrupt() {},
        async *events() {
          yield { type: "enclosure", tools: TOOLS };
          let i = 0;
          for await (const t of inbox) {
            for (const ev of respond(t, i++)) yield ev;
          }
        },
      };
      provider.sessions.push(sess);
      return sess;
    },
  };
  return provider;
}

const FAIL_TURN = [
  { type: "error", message: "inference failed: HTTP 500 — upstream down" },
  { type: "turn_end", meta: { error: true } },
];

async function runRepl({ providerA, providers, fallbacks, lines }) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (c) => { printed += c.toString(); });
  input.write(lines.join("\n") + "\n");
  const prepare = (ref) => {
    const p = providers[ref];
    if (!p) throw new Error(`unknown model provider: "${ref}"`);
    return { provider: p, model: "m" };
  };
  await startRepl({
    provider: providerA, model: "m", workspace: "/w",
    systemPromptFor: () => "sp",
    transcript: { write() {} },
    prepare, knownProviders: Object.keys(providers), fallbacks,
    input, output,
  });
  return printed;
}

test("a terminal provider failure falls back and replays the message", async () => {
  const a = fakeProvider("a", () => FAIL_TURN);
  const b = fakeProvider("b", (t) => [
    { type: "text", text: `B answers: ${t}` },
    { type: "turn_end", meta: {} },
  ]);
  const printed = await runRepl({
    providerA: a,
    providers: { "bad/x": null, "b/m": b }, // bad/x → prepare throws
    fallbacks: ["bad/x", "b/m"],
    lines: ["do the thing", "/quit"],
  });

  assert.deepEqual(a.sessions[0].sent, ["do the thing"]);
  assert.match(printed, /fallback bad\/x unavailable/);
  assert.match(printed, /falling back to b\/m — replaying/);
  assert.equal(b.sessions.length, 1, "fallback session must start");
  assert.deepEqual(b.sessions[0].sent, ["do the thing"], "failed message must be replayed");
  assert.deepEqual(b.sessions[0].opts.seed, [], "nothing succeeded yet — empty seed");
  assert.match(printed, /B answers: do the thing/);
});

test("fallback carries the completed conversation as seed", async () => {
  // A succeeds on turn 0, dies on turn 1.
  const a = fakeProvider("a", (t, i) => (i === 0
    ? [{ type: "text", text: `A answers: ${t}` }, { type: "turn_end", meta: {} }]
    : FAIL_TURN));
  const b = fakeProvider("b", (t) => [
    { type: "text", text: `B answers: ${t}` },
    { type: "turn_end", meta: {} },
  ]);
  const printed = await runRepl({
    providerA: a,
    providers: { "b/m": b },
    fallbacks: ["b/m"],
    lines: ["first question", "second question", "/quit"],
  });

  assert.deepEqual(a.sessions[0].sent, ["first question", "second question"]);
  assert.deepEqual(b.sessions[0].opts.seed, [
    { role: "user", text: "first question" },
    { role: "assistant", text: "A answers: first question" },
  ], "only the COMPLETED turn is seeded");
  assert.deepEqual(b.sessions[0].sent, ["second question"]);
  assert.match(printed, /B answers: second question/);
});

test("an exhausted fallback chain returns to the prompt with the session alive", async () => {
  // A fails every turn; there are no fallbacks. The user just gets the prompt
  // back and can quit cleanly (turn-level failure never kills the REPL).
  const a = fakeProvider("a", () => FAIL_TURN);
  const printed = await runRepl({
    providerA: a,
    providers: {},
    fallbacks: [],
    lines: ["try this", "/quit"],
  });
  assert.match(printed, /\[error\] inference failed/);
  assert.equal(a.sessions.length, 1, "no new session without fallbacks");
  assert.ok(!/falling back/.test(printed));
});

test("a session that THROWS falls back too (SDK-crash path)", async () => {
  const a = fakeProvider("a", () => { throw new Error("SDK exploded mid-turn"); });
  const b = fakeProvider("b", (t) => [
    { type: "text", text: `B answers: ${t}` },
    { type: "turn_end", meta: {} },
  ]);
  const printed = await runRepl({
    providerA: a,
    providers: { "b/m": b },
    fallbacks: ["b/m"],
    lines: ["do it", "/quit"],
  });
  assert.match(printed, /session failed: SDK exploded/);
  assert.match(printed, /falling back to b\/m/);
  assert.deepEqual(b.sessions[0].sent, ["do it"]);
  assert.match(printed, /B answers: do it/);
});

test("fallback skips the ref that resolves to the provider that just failed", async () => {
  const a = fakeProvider("a", () => FAIL_TURN);
  const b = fakeProvider("b", (t) => [{ type: "text", text: `B: ${t}` }, { type: "turn_end", meta: {} }]);
  const printed = await runRepl({
    providerA: a,
    providers: { "a/m": a, "b/m": b },
    fallbacks: ["a/m", "b/m"], // first entry IS the dead current provider
    lines: ["go", "/quit"],
  });
  assert.match(printed, /fallback a\/m skipped — it is the provider that just failed/);
  assert.equal(a.sessions.length, 1, "must not restart on the dead provider");
  assert.deepEqual(b.sessions[0].sent, ["go"]);
});

test("an exhausted configured chain says so instead of failing silently", async () => {
  const a = fakeProvider("a", () => FAIL_TURN);
  const printed = await runRepl({
    providerA: a,
    providers: {}, // every fallback ref is unresolvable
    fallbacks: ["gone/x"],
    lines: ["go", "/quit"],
  });
  assert.match(printed, /fallback gone\/x unavailable/);
  assert.match(printed, /fallback chain exhausted — staying on a\/m/);
});

test("a resumed transcript's history is carried into a fallback seed", async () => {
  const a = fakeProvider("a", () => FAIL_TURN);
  const b = fakeProvider("b", (t) => [{ type: "text", text: `B: ${t}` }, { type: "turn_end", meta: {} }]);
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (c) => { printed += c.toString(); });
  input.write("continue please\n/quit\n");
  await startRepl({
    provider: a, model: "m", workspace: "/w",
    systemPromptFor: () => "sp",
    transcript: { write() {} },
    prepare: (ref) => { if (ref !== "b/m") throw new Error("no"); return { provider: b, model: "m" }; },
    knownProviders: ["b/m"], fallbacks: ["b/m"],
    resume: { seed: [{ role: "user", text: "earlier q" }, { role: "assistant", text: "earlier a" }], sessionId: "sess-x" },
    input, output,
  });
  assert.deepEqual(b.sessions[0].opts.seed, [
    { role: "user", text: "earlier q" },
    { role: "assistant", text: "earlier a" },
  ], "resumed history must reach the fallback provider");
  assert.deepEqual(b.sessions[0].sent, ["continue please"]);
  assert.match(printed, /B: continue please/);
});
