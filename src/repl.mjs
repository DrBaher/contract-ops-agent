import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { assertEnclosure } from "./enclosure-assert.mjs";

function sdkUserMessage(text) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

// Minimal async queue so the readline loop can feed the SDK's streaming-input
// prompt iterable one user turn at a time.
export function makeInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(v) {
      items.push(v);
      if (wake) { const w = wake; wake = null; w(); }
    },
    close() {
      closed = true;
      if (wake) { const w = wake; wake = null; w(); }
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((res) => { wake = res; });
      }
    },
  };
}

// Serialize every readline question through one chain so a mid-turn gate prompt
// and a between-turn prompt can never be armed concurrently (Node's readline
// silently drops a second concurrent question). Each call may pass an
// AbortSignal; aborting resolves it to { aborted: true } without leaving the
// callback dangling.
export function makeAsker(rl) {
  let chain = Promise.resolve();
  const run = (question, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve({ aborted: true });
    let done = false;
    const finish = (v) => { if (!done) { done = true; signal?.removeEventListener("abort", onAbort); resolve(v); } };
    const onAbort = () => finish({ aborted: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    rl.question(question, signal ? { signal } : {}, (answer) => finish({ answer }));
  });
  return (question, signal) => {
    const result = chain.then(() => run(question, signal));
    chain = result.catch(() => {});
    return result;
  };
}

export async function startRepl({ options, transcript, input = process.stdin, output = process.stdout }) {
  const rl = readline.createInterface({ input, output });
  const ask = makeAsker(rl);
  const queue = makeInputQueue();

  // A pending gate question registers its AbortController here so SIGINT can
  // cancel it (→ declined, no approval recorded) instead of deadlocking.
  let activeGateAbort = null;
  const gatePrompter = async (_toolName, _input, detail) => {
    const ctl = new AbortController();
    activeGateAbort = ctl;
    try {
      const { answer, aborted } = await ask(`\n⚖ gate: ${detail}\n  approve? [y/N] `, ctl.signal);
      if (aborted) return false;
      return /^y(es)?$/i.test(String(answer).trim());
    } finally {
      if (activeGateAbort === ctl) activeGateAbort = null;
    }
  };

  const first = (await ask("legal-harness> ")).answer?.trim();
  if (!first || first === "/quit") { rl.close(); return; }
  queue.push(sdkUserMessage(first));
  transcript.write({ type: "user", text: first });

  const session = query({ prompt: queue, options: options(gatePrompter) });

  let interrupted = false;
  rl.on("SIGINT", async () => {
    // Cancel a pending gate first so it resolves to "declined" (no hang, no
    // stale approval), then interrupt the turn.
    if (activeGateAbort) activeGateAbort.abort();
    if (interrupted) { rl.close(); process.exit(130); }
    interrupted = true;
    output.write("\n[interrupting — Ctrl-C again to exit]\n");
    try { await session.interrupt(); } catch { /* session may already be idle */ }
  });

  let verified = false;
  for await (const message of session) {
    if (message.type === "system" && message.subtype === "init") {
      const n = assertEnclosure(message);
      verified = true;
      output.write(`[enclosure verified: ${n} contract-ops tools, nothing else]\n`);
      transcript.write({ type: "init", tools: message.tools });
      continue;
    }
    // Fail closed: no model output may be processed before the enclosure is
    // verified. If the SDK ever changes the init message shape, this throws
    // rather than silently running an unverified session.
    if (!verified && (message.type === "assistant" || message.type === "result")) {
      throw new Error("Enclosure not verified before model activity — refusing to continue (SDK init message shape may have changed).");
    }
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          output.write(`\n${block.text}\n`);
          transcript.write({ type: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          output.write(`  ⚙ ${block.name} ${JSON.stringify(block.input)}\n`);
          transcript.write({ type: "tool_use", tool: block.name, input: block.input });
        }
      }
      continue;
    }
    if (message.type === "result") {
      interrupted = false;
      transcript.write({ type: "result", subtype: message.subtype, turns: message.num_turns, cost: message.total_cost_usd });
      const next = (await ask("\nlegal-harness> ")).answer?.trim();
      if (!next || next === "/quit") { queue.close(); break; }
      transcript.write({ type: "user", text: next });
      queue.push(sdkUserMessage(next));
    }
  }
  rl.close();
}
