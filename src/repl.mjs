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
    if (closed) return resolve({ closed: true });
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
  if (text.startsWith("/")) return { kind: "unknown", cmd: text.split(/\s+/)[0] };
  return { kind: "send", text };
}

export const HELP_TEXT = `commands:
  /help   show this help
  /quit   exit (Ctrl-D also works)
  Ctrl-C  interrupt the current turn (twice to exit)
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
export async function startRepl({ provider, workspace, systemPrompt, model, transcript, input = process.stdin, output = process.stdout }) {
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

  // Prompt until we have something to send (or a quit). Commands are handled
  // here — only real prose ever reaches the model.
  const promptUser = async (q) => {
    for (;;) {
      const r = await ask(q);
      if (r.closed) return null; // Ctrl-D / EOF
      const parsed = parseReplInput(r.answer);
      if (parsed.kind === "quit") return null;
      if (parsed.kind === "send") return parsed.text;
      if (parsed.kind === "help") output.write(`${HELP_TEXT}\n`);
      else if (parsed.kind === "unknown") output.write(`unknown command: ${parsed.cmd} (try /help)\n`);
      // empty → just re-prompt
    }
  };

  const first = await promptUser("contract-ops-agent> ");
  if (first === null) { if (!rl.closed) rl.close(); return; }

  const session = provider.startSession({ workspace, systemPrompt, model, canUseTool });
  session.send(first);
  transcript.write({ type: "user", text: first });
  spinner.start();

  let interrupted = false;
  rl.on("SIGINT", async () => {
    if (activeGateAbort) activeGateAbort.abort();
    if (interrupted) { rl.close(); process.exit(130); }
    interrupted = true;
    spinner.stop();
    output.write("\n[interrupting — Ctrl-C again to exit]\n");
    try { await session.interrupt(); } catch { /* already idle */ }
  });

  let verified = false;
  let toolCount = 0; // tool calls in the current turn (for the footer)
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
        transcript.write({ type: "init", tools: ev.tools });
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
        const next = await promptUser("\ncontract-ops-agent> ");
        if (next === null) { session.end(); break; }
        transcript.write({ type: "user", text: next });
        session.send(next);
        spinner.start();
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
    try { session.end(); } catch { /* already ended */ }
    if (!rl.closed) rl.close();
  }
}
