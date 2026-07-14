// Claude provider — wraps the Claude Agent SDK.
//
// This backend keeps the Agent SDK deliberately: it is the ONLY path that
// inherits a Claude Code *subscription* login (the regular Messages API SDK
// supports API keys / WIF only, not the consumer Pro/Max OAuth). So Claude users
// keep subscription auth; other providers use the raw MCP-client loop.
//
// The enclosure here is the Agent SDK's three layers: disallowedTools strips the
// built-ins, canUseTool (the gate) denies anything not mcp__contract-ops__*, and
// the startup assertion (in the REPL) refuses to run on a dirty tool list.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveMcpServerPath, mcpServerEnv } from "../mcp-client.mjs";
import { makeInputQueue } from "../async-queue.mjs";

export const DISALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch",
  "NotebookEdit", "Task", "TodoWrite", "AskUserQuestion", "Skill",
  "EnterPlanMode", "ExitPlanMode", "KillShell", "BashOutput",
  "ListMcpResources", "ReadMcpResource",
  "CronCreate", "CronDelete", "CronList", "DesignSync", "EnterWorktree",
  "ExitWorktree", "Monitor", "PushNotification", "RemoteTrigger",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "TaskCreate", "TaskGet",
  "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch", "Workflow",
  "Agent", "Artifact", "SendUserFile", "LSP",
];

// The Agent SDK enclosure config. No `allowedTools`: it auto-approves before
// canUseTool fires and would bypass the confirmation gates.
export function buildOptions({ workspace, canUseTool, systemPrompt, model, maxTurns = 100 }) {
  if (!workspace) throw new Error("workspace is required");
  return {
    mcpServers: {
      "contract-ops": {
        command: process.execPath,
        args: [resolveMcpServerPath()],
        env: mcpServerEnv(workspace),
      },
    },
    strictMcpConfig: true,
    disallowedTools: [...DISALLOWED_TOOLS],
    permissionMode: "default",
    canUseTool,
    systemPrompt,
    settingSources: [],
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    ...(model ? { model } : {}),
    maxTurns,
  };
}

function sdkUserMessage(text) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

export const claudeProvider = {
  id: "claude",
  envKeys: ["ANTHROPIC_API_KEY"], // subscription/Claude Code login is inherited by the SDK
  defaultModel: undefined,        // let the Agent SDK pick its default

  // Start a session and return a normalized Session the REPL/tests can drive.
  // `canUseTool` is the gate (makeCanUseTool result). `_mutateOptions` is a
  // test hook to tamper with the SDK options (e.g. inject a foreign MCP server).
  startSession({ workspace, systemPrompt, model, canUseTool, maxTurns, _mutateOptions }) {
    const options = buildOptions({ workspace, canUseTool, systemPrompt, model, maxTurns });
    if (_mutateOptions) _mutateOptions(options);
    const queue = makeInputQueue();
    const q = query({ prompt: queue, options });
    return {
      send(text) { queue.push(sdkUserMessage(text)); },
      end() { queue.close(); },
      async interrupt() { try { await q.interrupt(); } catch { /* already idle */ } },
      async *events() {
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "init") {
            yield { type: "enclosure", tools: m.tools };
          } else if (m.type === "assistant") {
            for (const b of m.message?.content ?? []) {
              if (b.type === "text" && b.text) yield { type: "text", text: b.text };
              else if (b.type === "tool_use") yield { type: "tool_use", name: b.name, input: b.input };
            }
          } else if (m.type === "result") {
            yield { type: "turn_end", meta: { subtype: m.subtype, turns: m.num_turns, cost: m.total_cost_usd, text: m.result } };
          }
        }
      },
    };
  },
};
