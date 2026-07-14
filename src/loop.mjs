import { connectMcp, mcpResultText } from "./mcp-client.mjs";
import { makeInputQueue } from "./async-queue.mjs";
import { PREFIX } from "./gates.mjs";

// The provider-agnostic tool-calling loop for non-Claude backends. We own the
// loop, so the enclosure is a property of construction: the ONLY tools the model
// ever receives are the contract-ops MCP tools (exposed under the mcp__contract-
// ops__ prefix so gates.mjs / enclosure-assert / tests are unchanged). There are
// no built-ins to strip. Every tool call passes the gate before execution.
//
// `driver` is the per-provider adapter (owns the inference dialect):
//   pushUser(messages, text)                     append a user message (native shape)
//   async infer({ system, tools, messages, model, signal }) -> { text, toolCalls: [{id,name,input}], assistantMessage }
//   toolResultMessages(results: [{id, content, isError}]) -> native message(s) (array)
export function startLoopSession({ workspace, systemPrompt, model, canUseTool, driver, maxTurns = 25 }) {
  const inbox = makeInputQueue();
  const messages = [];
  let mcp = null;
  let interrupted = false;

  return {
    send(text) { inbox.push(text); },
    end() { inbox.close(); },
    async interrupt() { interrupted = true; },
    async *events() {
      mcp = await connectMcp(workspace);
      const rawByPrefixed = new Map();
      const exposed = mcp.tools.map((t) => {
        const name = PREFIX + t.name;
        rawByPrefixed.set(name, t.name);
        return { name, description: t.description, inputSchema: t.inputSchema };
      });
      // Layer 3: the exposed set is exactly the contract-ops tools (the REPL/test
      // asserts on it). Nothing else can exist — we never add another tool.
      yield { type: "enclosure", tools: exposed.map((t) => t.name) };
      try {
        for await (const userText of inbox) {
          driver.pushUser(messages, userText);
          let iterations = 0;
          for (;;) {
            if (interrupted) { interrupted = false; break; }
            if (++iterations > maxTurns) break;
            const { text, toolCalls, assistantMessage } = await driver.infer({ system: systemPrompt, tools: exposed, messages, model });
            if (assistantMessage) messages.push(assistantMessage);
            if (text) yield { type: "text", text };
            if (!toolCalls || toolCalls.length === 0) break;
            const results = [];
            for (const call of toolCalls) {
              yield { type: "tool_use", name: call.name, input: call.input };
              const outcome = await canUseTool(call.name, call.input);
              if (outcome.behavior === "allow") {
                const raw = rawByPrefixed.get(call.name);
                if (!raw) { results.push({ id: call.id, content: `"${call.name}" is not a contract-ops tool`, isError: true }); continue; }
                const r = await mcp.call(raw, outcome.updatedInput ?? call.input);
                results.push({ id: call.id, content: mcpResultText(r), isError: r.isError === true });
              } else {
                results.push({ id: call.id, content: outcome.message ?? "denied by the user", isError: true });
              }
            }
            messages.push(...driver.toolResultMessages(results));
          }
          yield { type: "turn_end", meta: {} };
        }
      } finally {
        await mcp?.close();
      }
    },
  };
}
