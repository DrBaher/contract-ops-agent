import { connectMcp, mcpResultText } from "./mcp-client.mjs";
import { makeInputQueue } from "./async-queue.mjs";
import { PREFIX } from "./gates.mjs";

export const DEFAULT_MAX_TURNS = 100;
export const DEFAULT_RETRY = { attempts: 3, baseMs: 1000 };

// An interrupt (Ctrl-C) aborts the in-flight inference; the OpenAI SDK and
// fetch both surface that as an abort-named rejection.
export function isAbortError(e) {
  return e?.name === "AbortError" || e?.name === "APIUserAbortError" || /\baborted?\b/i.test(String(e?.message ?? ""));
}

// Worth retrying: rate limits, server errors, request timeouts, and
// connection-level failures (no HTTP status at all — DNS, resets, TLS).
// Anything with a definite client-error status (401 bad key, 400 bad request,
// 404 bad model) will fail identically on retry, so don't.
export function isTransientError(e) {
  const status = e?.status ?? e?.response?.status;
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true;
  if (status) return false;
  return (
    e?.name === "APIConnectionError" ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|network|socket/i.test(String(e?.message ?? "") + String(e?.code ?? ""))
  );
}

export function describeError(e) {
  const status = e?.status ?? e?.response?.status;
  const msg = String(e?.message ?? e).slice(0, 300);
  return status ? `HTTP ${status} — ${msg}` : msg;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// The provider-agnostic tool-calling loop for non-Claude backends. We own the
// loop, so the enclosure is a property of construction: the ONLY tools the model
// ever receives are the contract-ops MCP tools (exposed under the mcp__contract-
// ops__ prefix so gates.mjs / enclosure-assert / tests are unchanged). There are
// no built-ins to strip. Every tool call passes the gate before execution, and
// only allowed tools surface as a `tool_use` event.
//
// Failure contract: a provider or tool failure ends the TURN, never the session.
// Transient inference errors (429/5xx/network) retry with backoff; anything
// else surfaces as an `error` event followed by `turn_end` so the REPL can
// prompt again with the conversation intact. Only enclosure setup failing is
// terminal (an `error` event, then the generator returns).
//
// `driver` is the per-provider adapter (owns the inference dialect):
//   pushUser(messages, text)                     append a user message (native shape)
//   async infer({ system, tools, messages, model, signal }) -> { text, toolCalls: [{id,name,input}], assistantMessage }
//   toolResultMessages(results: [{id, content, isError}]) -> native message(s) (array)
//   repairHistory?(messages)                     make history valid after an abnormal turn end
// `extraMounts` adds further MCP servers ([{prefix, connect}] — e.g. sign-cli
// in a signing mode); their tools are exposed under their own prefix and calls
// are routed to the owning client. A mount that fails to connect fails the
// session CLOSED (an error event, then return) — never a silent partial mount.
export function startLoopSession({ workspace, systemPrompt, model, canUseTool, driver, maxTurns = DEFAULT_MAX_TURNS, retry = DEFAULT_RETRY, seed = null, extraMounts = [], _connect = connectMcp }) {
  const inbox = makeInputQueue();
  const messages = [];
  // Resume support: seed the history with a prior conversation's user/assistant
  // turns ([{role, text}]) in the driver's native shape.
  if (seed?.length && driver.seedHistory) driver.seedHistory(messages, seed);
  let turnAbort = null; // AbortController for the in-flight turn (interrupt target)

  return {
    send(text) { inbox.push(text); },
    end() { inbox.close(); },
    async interrupt() { turnAbort?.abort(); },
    async *events() {
      const clients = [];
      try {
        try {
          clients.push({ prefix: PREFIX, client: await _connect(workspace) });
          for (const m of extraMounts) {
            clients.push({ prefix: m.prefix, client: await m.connect() });
          }
        } catch (e) {
          yield { type: "error", message: `could not start a tool server: ${describeError(e)}` };
          return;
        }
        const routeByName = new Map(); // prefixed name -> { client, raw }
        const exposed = [];
        for (const { prefix, client } of clients) {
          for (const t of client.tools) {
            const name = prefix + t.name;
            routeByName.set(name, { client, raw: t.name });
            exposed.push({ name, description: t.description, inputSchema: t.inputSchema });
          }
        }
        // The exposed set is exactly the mounted servers' tools (the REPL/test
        // asserts on it). Nothing else can exist — we never add another tool.
        yield { type: "enclosure", tools: exposed.map((t) => t.name) };

        for await (const userText of inbox) {
          driver.pushUser(messages, userText);
          if (driver.compactHistory) {
            const dropped = driver.compactHistory(messages);
            if (dropped > 0) yield { type: "notice", text: `context trimmed: dropped the ${dropped} oldest messages to stay within the model's window` };
          }
          const ctl = new AbortController(); // scoped to THIS turn only
          turnAbort = ctl;
          let iterations = 0;
          const meta = {};
          const usage = { input: 0, output: 0 }; // summed across the turn's model calls
          try {
            turn: for (;;) {
              if (ctl.signal.aborted) { meta.interrupted = true; break; }
              if (++iterations > maxTurns) {
                meta.maxTurnsHit = true;
                yield { type: "notice", text: `stopped after ${maxTurns} model calls (maxTurns) — the answer above may be incomplete` };
                break;
              }
              let inferred;
              for (let attempt = 1; ; attempt++) {
                try {
                  inferred = await driver.infer({ system: systemPrompt, tools: exposed, messages, model, signal: ctl.signal });
                  break;
                } catch (e) {
                  if (ctl.signal.aborted || isAbortError(e)) { meta.interrupted = true; break turn; }
                  if (attempt < retry.attempts && isTransientError(e)) {
                    const delay = retry.baseMs * 2 ** (attempt - 1);
                    yield { type: "notice", text: `provider error (${describeError(e)}) — retrying in ${Math.round(delay / 100) / 10}s (attempt ${attempt + 1}/${retry.attempts})` };
                    await abortableSleep(delay, ctl.signal);
                    if (ctl.signal.aborted) { meta.interrupted = true; break turn; }
                    continue;
                  }
                  yield { type: "error", message: `inference failed: ${describeError(e)}` };
                  meta.error = true;
                  break turn;
                }
              }
              const { text, toolCalls, assistantMessage } = inferred;
              if (inferred.usage) {
                usage.input += inferred.usage.input ?? 0;
                usage.output += inferred.usage.output ?? 0;
                meta.usage = usage;
              }
              if (assistantMessage) messages.push(assistantMessage);
              if (text) yield { type: "text", text };
              if (!toolCalls || toolCalls.length === 0) break;
              const results = [];
              for (const call of toolCalls) {
                const outcome = await canUseTool(call.name, call.input);
                if (outcome.behavior === "allow") {
                  yield { type: "tool_use", name: call.name, input: call.input }; // only allowed → executed
                  const route = routeByName.get(call.name);
                  if (!route) { results.push({ id: call.id, content: `"${call.name}" is not a mounted tool`, isError: true }); continue; }
                  try {
                    const r = await route.client.call(route.raw, outcome.updatedInput ?? call.input);
                    results.push({ id: call.id, content: mcpResultText(r), isError: r.isError === true });
                  } catch (e) {
                    // A dead/crashed MCP subprocess fails the CALL, not the
                    // session — the model sees the error and can tell the user.
                    results.push({ id: call.id, content: `tool call failed: ${describeError(e)}`, isError: true });
                  }
                } else {
                  results.push({ id: call.id, content: outcome.message ?? "denied by the user", isError: true });
                }
              }
              messages.push(...driver.toolResultMessages(results));
            }
          } finally {
            turnAbort = null;
            // An abnormal end can leave an assistant tool_calls message with no
            // tool results — invalid history that would wedge the next request.
            if ((meta.interrupted || meta.error) && driver.repairHistory) driver.repairHistory(messages);
          }
          yield { type: "turn_end", meta };
        }
      } finally {
        for (const { client } of clients) await client.close();
      }
    },
  };
}
