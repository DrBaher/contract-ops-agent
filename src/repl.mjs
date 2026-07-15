import readline from "node:readline";
import { assertEnclosure } from "./enclosure-assert.mjs";
import { makeCanUseTool, newSessionState } from "./gates.mjs";

// Serialize every readline question through one chain so a mid-turn gate prompt
// and a between-turn prompt can never be armed concurrently (Node's readline
// silently drops a second concurrent question). Each call may pass an
// AbortSignal; aborting resolves it to { aborted: true }. A closed stdin (EOF /
// Ctrl-D) resolves to { closed: true } instead of throwing ERR_USE_AFTER_CLOSE.
export function makeAsker(rl) {
  let chain = Promise.resolve();
  let closed = false;
  rl.on("close", () => { closed = true; });
  const run = (question, signal) => new Promise((resolve) => {
    if (closed) return resolve({ closed: true });
    if (signal?.aborted) return resolve({ aborted: true });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      rl.off("close", onClose);
      resolve(v);
    };
    const onAbort = () => finish({ aborted: true });
    const onClose = () => finish({ closed: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.on("close", onClose);
    try {
      rl.question(question, signal ? { signal } : {}, (answer) => finish({ answer }));
    } catch {
      finish({ closed: true });
    }
  });
  return (question, signal) => {
    const result = chain.then(() => run(question, signal));
    chain = result.catch(() => {});
    return result;
  };
}

// Provider-agnostic REPL. It owns the terminal (readline, gate prompts,
// transcript) and drives whatever `provider` hands back a normalized Session:
//   events: { type: "enclosure", tools } | { "text", text } | { "tool_use", name, input } | { "turn_end", meta }
export async function startRepl({ provider, workspace, systemPrompt, model, transcript, input = process.stdin, output = process.stdout }) {
  const rl = readline.createInterface({ input, output });
  const ask = makeAsker(rl);

  // A pending gate question registers its AbortController here so SIGINT can
  // cancel it (→ declined, no approval recorded) instead of deadlocking.
  let activeGateAbort = null;
  const gatePrompter = async (_toolName, _input, detail) => {
    const ctl = new AbortController();
    activeGateAbort = ctl;
    try {
      const { answer, aborted, closed } = await ask(`\n⚖ gate: ${detail}\n  approve? [y/N] `, ctl.signal);
      if (aborted || closed) return false;
      return /^y(es)?$/i.test(String(answer).trim());
    } finally {
      if (activeGateAbort === ctl) activeGateAbort = null;
    }
  };
  const canUseTool = makeCanUseTool(newSessionState(), gatePrompter, (e) => transcript.write(e));

  const r0 = await ask("contract-ops-agent> ");
  const first = r0.closed ? null : r0.answer?.trim();
  if (!first || first === "/quit") { if (!r0.closed) rl.close(); return; }

  const session = provider.startSession({ workspace, systemPrompt, model, canUseTool });
  session.send(first);
  transcript.write({ type: "user", text: first });

  let interrupted = false;
  rl.on("SIGINT", async () => {
    if (activeGateAbort) activeGateAbort.abort();
    if (interrupted) { rl.close(); process.exit(130); }
    interrupted = true;
    output.write("\n[interrupting — Ctrl-C again to exit]\n");
    try { await session.interrupt(); } catch { /* already idle */ }
  });

  let verified = false;
  try {
    for await (const ev of session.events()) {
      // Harness-side diagnostics (retries, provider failures) are not model
      // output — they may print before the enclosure is verified.
      if (ev.type === "notice") {
        output.write(`[${ev.text}]\n`);
        transcript.write({ type: "notice", text: ev.text });
        continue;
      }
      if (ev.type === "error") {
        output.write(`\n[error] ${ev.message}\n`);
        transcript.write({ type: "error", message: ev.message });
        continue;
      }
      if (ev.type === "enclosure") {
        const n = assertEnclosure({ tools: ev.tools });
        verified = true;
        output.write(`[enclosure verified: ${n} contract-ops tools, nothing else]\n`);
        transcript.write({ type: "init", tools: ev.tools });
        continue;
      }
      // Fail closed: no model output before the enclosure is verified.
      if (!verified) {
        throw new Error("Enclosure not verified before model activity — refusing to continue.");
      }
      if (ev.type === "text") {
        output.write(`\n${ev.text}\n`);
        transcript.write({ type: "assistant", text: ev.text });
      } else if (ev.type === "tool_use") {
        output.write(`  ⚙ ${ev.name} ${JSON.stringify(ev.input)}\n`);
        transcript.write({ type: "tool_use", tool: ev.name, input: ev.input });
      } else if (ev.type === "turn_end") {
        if (ev.meta?.interrupted) output.write(`[turn interrupted]\n`);
        interrupted = false;
        transcript.write({ type: "result", ...ev.meta });
        const r = await ask("\ncontract-ops-agent> ");
        const next = r.closed ? null : r.answer?.trim();
        if (!next || next === "/quit") { session.end(); break; }
        transcript.write({ type: "user", text: next });
        session.send(next);
      }
    }
  } catch (e) {
    // Anything that escapes the session (an SDK failure, the enclosure guard)
    // ends the REPL with a clean message, not a stack trace. Enclosure
    // failures stay fatal — we still refuse to continue.
    output.write(`\n[fatal] ${e?.message ?? e}\n`);
    transcript.write({ type: "fatal", message: String(e?.stack ?? e) });
    process.exitCode = 1;
  } finally {
    try { session.end(); } catch { /* already ended */ }
    if (!rl.closed) rl.close();
  }
}
