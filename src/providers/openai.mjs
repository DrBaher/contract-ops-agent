// OpenAI provider — the raw MCP-client loop with an OpenAI (Chat Completions)
// dialect. Auth is OPENAI_API_KEY (the user's own key). The enclosure is the
// same as any loop provider: the model only ever sees the contract-ops tools.
import OpenAI from "openai";
import { startLoopSession } from "../loop.mjs";

function safeJson(s) {
  try {
    const v = JSON.parse(s || "{}");
    // Tool inputs must be a plain object; a valid-but-non-object (string, number,
    // array, null) would confuse the gate and MCP call — coerce to {}.
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

// The OpenAI dialect adapter. Exported for unit testing the format mapping
// without a live key. `client` is injectable so tests can stub inference.
export function makeOpenAIDriver(client) {
  return {
    pushUser(messages, text) {
      messages.push({ role: "user", content: text });
    },
    // Map exposed MCP tools → OpenAI function tools.
    toOpenAITools(tools) {
      return tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    },
    async infer({ system, tools, messages, model, signal }) {
      const res = await client.chat.completions.create(
        {
          model,
          messages: [{ role: "system", content: system }, ...messages],
          tools: this.toOpenAITools(tools),
          tool_choice: "auto",
        },
        signal ? { signal } : {},
      );
      const m = res.choices[0].message;
      // Accept any tool_call carrying a function name — OpenAI-*compatible*
      // endpoints (Gemini/Grok/Ollama/…) often omit the `type` field; filtering
      // on type would drop the call yet leave the assistant's tool_calls in
      // history, wedging the next request. If none normalize, drop tool_calls
      // from the assistant message so history stays consistent.
      const toolCalls = (m.tool_calls ?? [])
        .filter((tc) => tc?.function?.name)
        .map((tc) => ({ id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) }));
      const assistantMessage = toolCalls.length ? m : { ...m, tool_calls: undefined };
      return { text: m.content || "", toolCalls, assistantMessage };
    },
    // OpenAI wants one `role:"tool"` message per result, keyed by tool_call_id.
    toolResultMessages(results) {
      return results.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: r.isError ? `ERROR: ${r.content}` : String(r.content ?? ""),
      }));
    },
  };
}

// Factory for any OpenAI-*compatible* backend. `baseURL` points it at a
// non-OpenAI endpoint (Gemini/Grok/DeepSeek/Ollama/OpenRouter/… all expose an
// OpenAI-shaped API), and `apiKeyEnv` names the env var holding its key. With no
// baseURL it's plain OpenAI. The enclosure is identical — it's the same loop.
export function makeOpenAIProvider({ id = "openai", apiKeyEnv = "OPENAI_API_KEY", baseURL, defaultModel = "gpt-4o" } = {}) {
  return {
    id,
    envKeys: [apiKeyEnv],
    defaultModel,
    startSession({ workspace, systemPrompt, model, canUseTool, maxTurns }) {
      const client = new OpenAI({
        apiKey: process.env[apiKeyEnv],
        ...(baseURL ? { baseURL } : {}),
      });
      const driver = makeOpenAIDriver(client);
      return startLoopSession({ workspace, systemPrompt, model: model ?? defaultModel, canUseTool, maxTurns, driver });
    },
  };
}

export const openaiProvider = makeOpenAIProvider();
