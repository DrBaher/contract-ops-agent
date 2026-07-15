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
  // Lines that arrive while NO question is pending (readline only emits "line"
  // then — a pending question consumes them via its callback). Without this
  // buffer, piped input beyond the first line is silently dropped, so
  // `echo "task" | contract-ops-agent` style scripting can never work.
  const lines = [];
  rl.on("line", (l) => lines.push(l));
  rl.on("close", () => { closed = true; });
  const run = (question, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve({ aborted: true });
    if (lines.length) {
      // Serve buffered (piped) input, echoing the exchange so the output
      // still reads like a session.
      const answer = lines.shift();
      rl.output?.write?.(`${question}${answer}\n`);
      return resolve({ answer });
    }
    // `readableEnded` covers stdin that finished BEFORE this interface was
    // created (e.g. the setup wizard's readline drained a pipe first) — no
    // close event will ever fire, and an unguarded question would hang the
    // process on an unsettled await.
    if (closed || rl.input?.readableEnded) return resolve({ closed: true });
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

// Classify one line of prompt input. Slash-prefixed lines are REPL commands,
// never sent to the model — an unknown /command almost certainly wasn't meant
// as contract prose. Exported for tests.
export function parseReplInput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { kind: "empty" };
  if (text === "/quit" || text === "/exit" || text === "/q") return { kind: "quit" };
  if (text === "/help" || text === "/?") return { kind: "help" };
  if (text === "/model") return { kind: "model" };
  if (text.startsWith("/model ")) return { kind: "model", ref: text.slice("/model ".length).trim() };
  if (text.startsWith("/")) return { kind: "unknown", cmd: text.split(/\s+/)[0] };
  return { kind: "send", text };
}

export const HELP_TEXT = `commands:
  /help           show this help
  /model          show the current model and available providers
  /model <ref>    switch model (e.g. /model openai/gpt-4o) — context resets
  /quit           exit (Ctrl-D also works)
  Ctrl-C          interrupt the current turn (twice to exit)
anything else is sent to the agent.`;

// A single-line activity indicator so a long inference doesn't look like a
// hang. TTY-only: tests and pipes see nothing.
function makeSpinner(output) {
  if (!output.isTTY) return { start() {}, stop() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let timer = null;
  let i = 0;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => output.write(`\r${frames[i++ % frames.length]} working… `), 100);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      output.write("\r\x1b[2K"); // clear the spinner line
    },
  };
}

// One dim line of turn accounting: tool calls, and whatever the provider
// reports (Claude: total cost; loop providers: token usage).
function turnFooter(meta, toolCount) {
  const parts = [`${toolCount} tool call${toolCount === 1 ? "" : "s"}`];
  if (meta?.cost != null) parts.push(`$${meta.cost.toFixed(4)}`);
  if (meta?.usage) parts.push(`${meta.usage.input} in / ${meta.usage.output} out tokens`);
  if (meta?.subtype && meta.subtype !== "success") parts.push(`ended: ${meta.subtype}`);
  if (meta?.maxTurnsHit) parts.push("hit maxTurns");
  return `[${parts.join(" · ")}]`;
}

// Provider-agnostic REPL. It owns the terminal (readline, gate prompts,
// transcript) and drives whatever `provider` hands back a normalized Session:
//   events: { type: "enclosure", tools } | { "text", text } | { "tool_use", name, input }
//         | { "notice", text } | { "error", message } | { "turn_end", meta }
// `prepare(ref) -> {provider, model}` (throws on bad ref / missing key) enables
// /model switching; a switch ends the session and starts a fresh one — context
// resets, the enclosure is re-verified. `systemPromptFor(providerId)` supplies
// the (possibly provider-specific) system prompt for each session.
export async function startRepl({ provider, workspace, systemPromptFor, model, transcript, prepare = null, knownProviders = [], resume = null, fallbacks = [], input = process.stdin, output = process.stdout }) {
  const rl = readline.createInterface({ input, output });
  const ask = makeAsker(rl);
  const spinner = makeSpinner(output);

  // A pending gate question registers its AbortController here so SIGINT can
  // cancel it (→ declined, no approval recorded) instead of deadlocking.
  let activeGateAbort = null;
  const gatePrompter = async (_toolName, _input, detail) => {
    const ctl = new AbortController();
    activeGateAbort = ctl;
    spinner.stop(); // the question owns the terminal while it's pending
    try {
      const { answer, aborted, closed } = await ask(`\n⚖ gate: ${detail}\n  approve? [y/N] `, ctl.signal);
      if (aborted || closed) return false;
      return /^y(es)?$/i.test(String(answer).trim());
    } finally {
      if (activeGateAbort === ctl) activeGateAbort = null;
      spinner.start(); // the turn is still running
    }
  };
  const canUseTool = makeCanUseTool(newSessionState(), gatePrompter, (e) => transcript.write(e));

  let cur = { provider, model };
  const refOf = (c) => c.provider.id + (c.model ? `/${c.model}` : "");

  // Prompt until we have something to send (or a quit). Commands are handled
  // here — only real prose ever reaches the model. A /model switch updates
  // `cur` and is reported back so the caller can restart the session.
  const promptUser = async (q) => {
    let switched = false;
    for (;;) {
      const r = await ask(q);
      if (r.closed) return null; // Ctrl-D / EOF
      const parsed = parseReplInput(r.answer);
      if (parsed.kind === "quit") return null;
      if (parsed.kind === "send") return { text: parsed.text, switched };
      if (parsed.kind === "help") output.write(`${HELP_TEXT}\n`);
      else if (parsed.kind === "model") {
        if (!prepare) { output.write(`model: ${refOf(cur)} (switching not available here)\n`); continue; }
        if (!parsed.ref) {
          output.write(`model: ${refOf(cur)}\nproviders: ${knownProviders.join(", ")}\nswitch with /model <provider[/model]>\n`);
          continue;
        }
        try {
          cur = prepare(parsed.ref);
          switched = true;
          output.write(`[switched to ${refOf(cur)} — starts with your next message; context resets]\n`);
          transcript.write({ type: "model", ref: refOf(cur) });
        } catch (e) {
          output.write(`cannot switch: ${e.message}\n`);
        }
      }
      else if (parsed.kind === "unknown") output.write(`unknown command: ${parsed.cmd} (try /help)\n`);
      // empty → just re-prompt
    }
  };

  const r0 = await promptUser("contract-ops-agent> ");
  if (r0 === null) { if (!rl.closed) rl.close(); return; }

  let activeSession = null;
  let interrupted = false;
  rl.on("SIGINT", async () => {
    if (activeGateAbort) activeGateAbort.abort();
    if (interrupted) { rl.close(); process.exit(130); }
    interrupted = true;
    spinner.stop();
    output.write("\n[interrupting — Ctrl-C again to exit]\n");
    try { await activeSession?.interrupt(); } catch { /* already idle */ }
  });

  // One iteration per session; a /model switch ends the session and loops with
  // the pending message for the new provider.
  let pending = r0.text;
  let resumeInfo = resume; // applied to the FIRST session only — a /model switch starts clean
  // Fallback state: config.fallbacks refs are consumed left-to-right when a
  // turn ends in a terminal provider error. seedLog mirrors the successful
  // conversation (user/assistant text) so a fallback session can be re-seeded.
  const fallbackQueue = [...fallbacks];
  const seedLog = [];
  let lastUser = null;
  let turnTexts = [];
  try {
    while (pending !== null) {
      const session = cur.provider.startSession({
        workspace, systemPrompt: systemPromptFor(cur.provider.id), model: cur.model, canUseTool,
        ...(resumeInfo ? { seed: resumeInfo.seed, resume: resumeInfo.sessionId ?? undefined } : {}),
      });
      resumeInfo = null;
      activeSession = session;
      session.send(pending);
      transcript.write({ type: "user", text: pending });
      lastUser = pending;
      turnTexts = [];
      pending = null;
      spinner.start();

      let verified = false; // per session — every new enclosure is re-verified
      let toolCount = 0;    // tool calls in the current turn (for the footer)
      try {
        for await (const ev of session.events()) {
          spinner.stop();
          // Harness-side diagnostics (retries, provider failures) are not model
          // output — they may print before the enclosure is verified.
          if (ev.type === "notice") {
            output.write(`[${ev.text}]\n`);
            transcript.write({ type: "notice", text: ev.text });
            spinner.start();
            continue;
          }
          if (ev.type === "error") {
            output.write(`\n[error] ${ev.message}\n`);
            transcript.write({ type: "error", message: ev.message });
            spinner.start();
            continue;
          }
          if (ev.type === "enclosure") {
            const n = assertEnclosure({ tools: ev.tools });
            verified = true;
            output.write(`[enclosure verified: ${n} contract-ops tools, nothing else]\n`);
            transcript.write({ type: "init", tools: ev.tools, ...(ev.sessionId ? { sessionId: ev.sessionId } : {}) });
            spinner.start();
            continue;
          }
          // Fail closed: no model output before the enclosure is verified.
          if (!verified) {
            throw new Error("Enclosure not verified before model activity — refusing to continue.");
          }
          if (ev.type === "text") {
            output.write(`\n${ev.text}\n`);
            transcript.write({ type: "assistant", text: ev.text });
            turnTexts.push(ev.text);
            spinner.start();
          } else if (ev.type === "tool_use") {
            toolCount++;
            output.write(`  ⚙ ${ev.name} ${JSON.stringify(ev.input)}\n`);
            transcript.write({ type: "tool_use", tool: ev.name, input: ev.input });
            spinner.start();
          } else if (ev.type === "turn_end") {
            if (ev.meta?.interrupted) output.write(`[turn interrupted]\n`);
            output.write(`${turnFooter(ev.meta, toolCount)}\n`);
            toolCount = 0;
            interrupted = false;
            transcript.write({ type: "result", ...ev.meta });
            // A terminal provider failure triggers the fallback chain: switch
            // to the next viable ref, re-seed the conversation so far, and
            // replay the message the dead provider never answered.
            if (ev.meta?.error && prepare) {
              let fell = false;
              while (fallbackQueue.length) {
                const ref = fallbackQueue.shift();
                try { cur = prepare(ref); fell = true; break; }
                catch (e) { output.write(`[fallback ${ref} unavailable: ${e.message}]\n`); }
              }
              if (fell) {
                const noCarry = cur.provider.id === "claude" ? "; prior context can't be carried to claude" : "";
                output.write(`[falling back to ${refOf(cur)} — replaying your last message${noCarry}]\n`);
                transcript.write({ type: "model", ref: refOf(cur), fallback: true });
                resumeInfo = { seed: [...seedLog] };
                pending = lastUser;
                session.end();
                break;
              }
            } else if (lastUser) {
              // Only completed turns enter the fallback seed.
              seedLog.push({ role: "user", text: lastUser }, ...turnTexts.map((t) => ({ role: "assistant", text: t })));
            }
            const next = await promptUser("\ncontract-ops-agent> ");
            if (next === null) { session.end(); break; }
            if (next.switched) { pending = next.text; session.end(); break; } // restart on the new provider
            transcript.write({ type: "user", text: next.text });
            session.send(next.text);
            lastUser = next.text;
            turnTexts = [];
            spinner.start();
          }
        }
      } finally {
        try { session.end(); } catch { /* already ended */ }
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
    spinner.stop();
    if (!rl.closed) rl.close();
  }
}
