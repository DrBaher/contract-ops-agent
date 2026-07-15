// Signing modes: gate policy, enclosure assertion, serve args, double opt-in,
// prompt honesty, loop multi-mount routing, and the typed-consent gate driven
// through the real REPL. Offline (fake mounts) except the last two tests,
// which spawn the real `sign mcp serve` and skip when sign-cli is absent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { decide, makeCanUseTool, newSessionState, PREFIX } from "../src/gates.mjs";
import { assertEnclosure } from "../src/enclosure-assert.mjs";
import { SIGN_PREFIX, allowedSignTools, signServeArgs, resolveSigningMode } from "../src/signing.mjs";
import { buildSystemPrompt, SYSTEM_PROMPT } from "../src/system-prompt.mjs";
import { connectSign } from "../src/mcp-client.mjs";
import { startLoopSession } from "../src/loop.mjs";
import { startRepl } from "../src/repl.mjs";
import { makeInputQueue } from "../src/async-queue.mjs";

const s = (short) => `${SIGN_PREFIX}${short}`;

let signAvailable = false;
try { execFileSync("sign", ["--help"], { stdio: "ignore" }); signAvailable = true; } catch { /* skip live */ }
const skipNoSign = signAvailable ? false : "sign-cli not installed";

test("G1: signing off — every sign tool is denied at the gate", () => {
  for (const short of ["request_show", "sign", "preview"]) {
    const d = decide(s(short), {}, newSessionState("off"));
    assert.equal(d.kind, "deny", short);
    assert.match(d.detail, /disabled/);
  }
});

test("G2: prepare mode — reads allow, writes confirm, the signing act is denied", () => {
  const sess = newSessionState("prepare");
  assert.equal(decide(s("request_show"), {}, sess).kind, "allow");
  assert.equal(decide(s("pdf_detect_signature_field"), {}, sess).kind, "allow");
  const prev = decide(s("preview"), { output: "draft.pdf" }, sess);
  assert.equal(prev.kind, "confirm");
  assert.equal(prev.challenge, undefined, "prepare writes are y/N, not typed");
  for (const act of ["sign", "signer_decline", "document", "signer_reissue_token"]) {
    assert.equal(decide(s(act), {}, sess).kind, "deny", act);
  }
});

test("G3: full mode — the signing act demands a TYPED challenge, never remembered", () => {
  const sess = newSessionState("full");
  const d = decide(s("sign"), { request_id: "req-42" }, sess);
  assert.equal(d.kind, "confirm");
  assert.equal(d.challenge, "req-42", "challenge is the FULL target, not a basename");
  assert.equal(d.requireInteractive, true, "signing acts require an interactive TTY");
  assert.equal(d.key, null, "signing approval must never be remembered");
  assert.match(d.detail, /SIGNING ACTION/);
  // `document` uses input_path (the real MCP param) — must resolve, not collapse
  const doc = decide(s("document"), { input_path: "contracts/nda-final.pdf", out_path: "sealed.pdf", signer_name: "B" }, sess);
  assert.equal(doc.kind, "confirm");
  assert.equal(doc.challenge, "contracts/nda-final.pdf", "document target must be its input_path");
  assert.match(doc.detail, /nda-final\.pdf/);
  // reissue is y/N, not typed
  assert.equal(decide(s("signer_reissue_token"), { request_id: "r" }, sess).challenge, undefined);
  // contract-ops tools are untouched by signing mode
  assert.equal(decide(`${PREFIX}lint_contract`, { path: "a.md" }, sess).kind, "allow");
  // and the run escape hatch still refuses sign regardless of mode
  assert.equal(decide(`${PREFIX}run`, { cli: "sign", args: ["request", "create"] }, sess).kind, "deny");
});

test("G3b: a signing act with no resolvable target is DENIED, not blindly challenged", () => {
  const sess = newSessionState("full");
  // empty-string request_id must not short-circuit a real path, and a call
  // with no target at all must be refused (never a generic 'type sign' prompt)
  assert.equal(decide(s("sign"), {}, sess).kind, "deny");
  assert.equal(decide(s("sign"), { request_id: "" }, sess).kind, "deny");
  assert.equal(decide(s("document"), { out_path: "x.pdf" }, sess).kind, "deny", "out_path alone is not the doc being sealed");
  // an empty request_id must NOT hide a real input_path — the path wins
  const d = decide(s("sign"), { request_id: "", input: "real/target.pdf" }, sess);
  assert.equal(d.kind, "confirm");
  assert.equal(d.challenge, "real/target.pdf");
});

test("G4: makeCanUseTool hands the challenge to the prompter", async () => {
  const seen = [];
  const gate = makeCanUseTool(newSessionState("full"), async (_t, _i, _d, challenge) => {
    seen.push(challenge);
    return challenge === "req-1"; // simulate correct typing only for req-1
  }, () => {});
  assert.equal((await gate(s("sign"), { request_id: "req-1" })).behavior, "allow");
  assert.equal((await gate(s("sign"), { request_id: "req-2" })).behavior, "deny");
  assert.deepEqual(seen, ["req-1", "req-2"]);
});

test("E1: enclosure assertion accepts exactly the mode's sign tools", () => {
  const co = [`${PREFIX}lint_contract`];
  assert.throws(() => assertEnclosure({ tools: [...co, s("request_show")] }), /breach/);
  assert.equal(assertEnclosure({ tools: [...co, s("request_show")] }, "prepare"), 2);
  assert.throws(() => assertEnclosure({ tools: [...co, s("sign")] }, "prepare"), /breach.*sign/);
  assert.equal(assertEnclosure({ tools: [...co, s("sign")] }, "full"), 2);
  assert.throws(() => assertEnclosure({ tools: [...co, "mcp__other__x"] }, "full"), /breach/);
});

test("E2: a signing mode with NO sign tools mounted fails loudly (no silent lie)", () => {
  const co = [`${PREFIX}lint_contract`];
  // off mode is fine with no sign tools
  assert.equal(assertEnclosure({ tools: co }, "off"), 1);
  // but an active mode that mounted zero sign tools (e.g. the SDK rejected the
  // sign server) must throw, not pretend to have signing capability
  assert.throws(() => assertEnclosure({ tools: co }, "prepare"), /no sign tools mounted/);
  assert.throws(() => assertEnclosure({ tools: co }, "full"), /no sign tools mounted/);
});

test("S1: serve args + double opt-in", () => {
  // BOTH modes pass the --tool whitelist so mount and enclosure assertion can
  // never drift (a sign-cli upgrade adding tools must not breach full mode).
  const full = signServeArgs("full");
  assert.ok(full.join(" ").includes("--capability tools"), "must advertise only the tools surface");
  assert.ok(!full.includes("--read-only"), "full mode must not be read-only");
  assert.equal(full.filter((a) => a === "--tool").length, allowedSignTools("full").length);
  assert.ok(full.includes("sign"), "full mode whitelist includes the signing act");
  const prep = signServeArgs("prepare");
  assert.ok(prep.includes("--read-only"), "prepare mode must be read-only");
  assert.ok(prep.join(" ").includes("--capability tools"));
  assert.ok(prep.filter((a) => a === "--tool").length === allowedSignTools("prepare").length);
  assert.ok(!allowedSignTools("prepare").includes("sign"));

  assert.deepEqual(resolveSigningMode({}, []), { mode: "off", warning: null });
  const flagless = resolveSigningMode({ signing: { mode: "full" } }, []);
  assert.equal(flagless.mode, "off");
  assert.match(flagless.warning, /--enable-signing/);
  assert.equal(resolveSigningMode({ signing: { mode: "full" } }, ["--enable-signing"]).mode, "full");
  assert.throws(() => resolveSigningMode({ signing: { mode: "yolo" } }, []), /invalid signing.mode/);
});

test("P1: the system prompt is honest per mode", () => {
  assert.equal(buildSystemPrompt("claude", "off"), SYSTEM_PROMPT);
  const prep = buildSystemPrompt("claude", "prepare");
  assert.notEqual(prep, SYSTEM_PROMPT, "the signing paragraph must actually be replaced");
  assert.match(prep, /signing ACT itself is impossible/);
  const full = buildSystemPrompt("claude", "full");
  assert.match(full, /NEVER initiate a signing action/);
  assert.ok(!/Signing is impossible here by design/.test(full));
});

test("L1: loop multi-mount — routing per prefix, fail-closed on mount failure", async () => {
  const calls = [];
  const co = { tools: [{ name: "lint_contract", description: "", inputSchema: {} }], call: async (n, a) => { calls.push(["co", n]); return { content: [{ type: "text", text: "co ok" }] }; }, close: async () => {} };
  const sg = { tools: [{ name: "request_show", description: "", inputSchema: {} }], call: async (n, a) => { calls.push(["sign", n]); return { content: [{ type: "text", text: "sign ok" }] }; }, close: async () => {} };
  const driver = {
    pushUser(m, t) { m.push({ role: "user", content: t }); },
    async infer({ tools, messages }) {
      if (messages.length === 1) {
        return { text: "", toolCalls: [
          { id: "1", name: `${PREFIX}lint_contract`, input: {} },
          { id: "2", name: `${SIGN_PREFIX}request_show`, input: {} },
        ], assistantMessage: { role: "assistant" } };
      }
      return { text: `saw ${tools.map((t) => t.name).join(",")}`, toolCalls: [], assistantMessage: { role: "assistant" } };
    },
    toolResultMessages(rs) { return rs.map((r) => ({ role: "tool", tool_call_id: r.id, content: String(r.content) })); },
  };
  const session = startLoopSession({
    workspace: "/w", systemPrompt: "sp", canUseTool: async () => ({ behavior: "allow" }), driver,
    extraMounts: [{ prefix: SIGN_PREFIX, connect: async () => sg }],
    _connect: async () => co,
  });
  const events = [];
  session.send("go");
  for await (const ev of session.events()) { events.push(ev); if (ev.type === "turn_end") break; }
  session.end();
  const enclosure = events.find((e) => e.type === "enclosure");
  assert.deepEqual(enclosure.tools, [`${PREFIX}lint_contract`, `${SIGN_PREFIX}request_show`]);
  assert.deepEqual(calls, [["co", "lint_contract"], ["sign", "request_show"]], "each call must reach its own server");

  // fail-closed: a broken sign mount kills the session before any tool exists
  const broken = startLoopSession({
    workspace: "/w", systemPrompt: "sp", canUseTool: async () => ({ behavior: "allow" }), driver,
    extraMounts: [{ prefix: SIGN_PREFIX, connect: async () => { throw new Error("sign not found"); } }],
    _connect: async () => co,
  });
  broken.send("go");
  const evs = [];
  for await (const ev of broken.events()) evs.push(ev);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "error");
});

test("R1: the REPL's typed gate — wrong input declines, exact input approves", async () => {
  // A fake provider whose session asks the gate to sign REQ-7 on each turn.
  const outcomes = [];
  const provider = {
    id: "fake", envKeys: [], keyOptional: true,
    startSession({ canUseTool }) {
      const inbox = makeInputQueue();
      return {
        send(t) { inbox.push(t); },
        end() { inbox.close(); },
        async interrupt() {},
        async *events() {
          yield { type: "enclosure", tools: [`${PREFIX}lint_contract`, `${SIGN_PREFIX}sign`] };
          for await (const _t of inbox) {
            const o = await canUseTool(`${SIGN_PREFIX}sign`, { request_id: "REQ-7" });
            outcomes.push(o.behavior);
            yield { type: "text", text: `gate said ${o.behavior}` };
            yield { type: "turn_end", meta: {} };
          }
        },
      };
    },
  };
  const input = new PassThrough();
  input.isTTY = true; // signing acts require an interactive terminal
  const output = new PassThrough();
  let printed = "";
  output.on("data", (c) => { printed += c.toString(); });
  // turn 1: mistype the challenge → declined; turn 2: type it exactly → allowed
  input.write("sign it\nREQ-9\nsign it again\nREQ-7\n/quit\n");
  await startRepl({
    provider, model: "m", workspace: "/w",
    systemPromptFor: () => "sp",
    transcript: { write() {} },
    signingMode: "full",
    input, output,
  });
  assert.deepEqual(outcomes, ["deny", "allow"]);
  assert.match(printed, /exactly: REQ-7/);
  assert.match(printed, /gate said deny/);
  assert.match(printed, /gate said allow/);
});

test("R2: a signing act is REFUSED on non-interactive (piped) input", async () => {
  const outcomes = [];
  const provider = {
    id: "fake", envKeys: [], keyOptional: true,
    startSession({ canUseTool }) {
      const inbox = makeInputQueue();
      return {
        send(t) { inbox.push(t); }, end() { inbox.close(); }, async interrupt() {},
        async *events() {
          yield { type: "enclosure", tools: [`${PREFIX}lint_contract`, `${SIGN_PREFIX}sign`] };
          for await (const _t of inbox) {
            const o = await canUseTool(`${SIGN_PREFIX}sign`, { request_id: "REQ-7" });
            outcomes.push(o.behavior);
            yield { type: "text", text: `gate said ${o.behavior}` };
            yield { type: "turn_end", meta: {} };
          }
        },
      };
    },
  };
  const input = new PassThrough(); // NOT a TTY — piped
  const output = new PassThrough();
  let printed = "";
  output.on("data", (c) => { printed += c.toString(); });
  input.write("sign it\n/quit\n"); // refused outright — no typed answer is even consumed
  await startRepl({
    provider, model: "m", workspace: "/w",
    systemPromptFor: () => "sp", transcript: { write() {} }, signingMode: "full",
    input, output,
  });
  assert.deepEqual(outcomes, ["deny"], "piped input can never approve a signature");
  assert.match(printed, /REFUSED — a signing action needs interactive confirmation/);
});

test("LIVE1: real `sign mcp serve` in prepare mode hides the signing act server-side", { skip: skipNoSign }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "coa-sign-"));
  const mcp = await connectSign(ws, "prepare");
  try {
    const names = mcp.tools.map((t) => t.name);
    assert.ok(names.includes("request_show"), names.join(","));
    for (const hidden of ["sign", "signer_decline", "document"]) {
      assert.ok(!names.includes(hidden), `"${hidden}" must not be exposed in prepare mode`);
    }
  } finally {
    await mcp.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("LIVE2: real `sign mcp serve` in full mode exposes the signing act", { skip: skipNoSign }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "coa-sign-"));
  const mcp = await connectSign(ws, "full");
  try {
    const names = mcp.tools.map((t) => t.name);
    assert.ok(names.includes("sign"));
    assert.ok(names.includes("request_show"));
  } finally {
    await mcp.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("G5: no signing challenge is ever empty — absent/blank targets deny", () => {
  const sess = newSessionState("full");
  // whitespace-only and absent targets carry no binding → deny outright
  for (const path of ["  ", "\t"]) assert.equal(decide(s("sign"), { path }, sess).kind, "deny", JSON.stringify(path));
  assert.equal(decide(s("document"), {}, sess).kind, "deny");
  // any target that DOES resolve yields a confirm whose challenge is the full,
  // non-empty target (bare Enter can never satisfy it)
  const d = decide(s("sign"), { path: "/" }, sess);
  assert.equal(d.kind, "confirm");
  assert.equal(d.challenge, "/");
  assert.ok(d.challenge.length > 0);
});

test("LIVE3: full-mode live catalog is a subset of the allowed list (no drift)", { skip: skipNoSign }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "coa-sign-"));
  const mcp = await connectSign(ws, "full");
  try {
    const allowed = new Set(allowedSignTools("full"));
    for (const t of mcp.tools) {
      assert.ok(allowed.has(t.name), `live full-mode tool "${t.name}" is outside allowedSignTools("full") — enclosure would breach`);
    }
  } finally {
    await mcp.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
