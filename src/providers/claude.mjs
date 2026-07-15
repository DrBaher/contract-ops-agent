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
import { resolveMcpServerPath, mcpServerEnv, signServerEnv } from "../mcp-client.mjs";
import { makeInputQueue } from "../async-queue.mjs";
import { signServeArgs } from "../signing.mjs";

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
export function buildOptions({ workspace, canUseTool, systemPrompt, model, maxTurns = 100, resume, signingMode = "off" }) {
  if (!workspace) throw new Error("workspace is required");
  return {
    ...(resume ? { resume } : {}), // SDK session id — resumes the conversation server-side
    mcpServers: {
      "contract-ops": {
        command: process.execPath,
        args: [resolveMcpServerPath()],
        env: mcpServerEnv(workspace),
      },
      // Signing modes mount sign-cli's own MCP server (least-privilege args
      // per mode). The SDK config has no cwd field, and sign's DB is
      // cwd-relative — spawn via sh so it runs in the workspace, sharing the
      // DB with the human's sign-cli.
      ...(signingMode !== "off" ? {
        sign: {
          command: "/bin/sh",
          args: ["-c", `cd ${JSON.stringify(workspace)} && exec sign ${signServeArgs(signingMode).map((a) => JSON.stringify(a)).join(" ")}`],
          env: signServerEnv(),
        },
      } : {}),
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
  startSession({ workspace, systemPrompt, model, canUseTool, maxTurns, resume, signingMode = "off", _mutateOptions }) {
    const options = buildOptions({ workspace, canUseTool, systemPrompt, model, maxTurns, resume, signingMode });
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
            // session_id makes the conversation resumable (--resume) later.
            yield { type: "enclosure", tools: m.tools, sessionId: m.session_id };
          } else if (m.type === "assistant") {
            for (const b of m.message?.content ?? []) {
              if (b.type === "text" && b.text) yield { type: "text", text: b.text };
              else if (b.type === "tool_use") yield { type: "tool_use", name: b.name, input: b.input };
            }
          } else if (m.type === "result") {
            // Normalize SDK failure subtypes into the same meta.error the loop
            // providers set — fallback chains key off it (max_turns is a cap,
            // not a provider failure, so it doesn't count).
            const failed = typeof m.subtype === "string" && m.subtype.startsWith("error") && m.subtype !== "error_max_turns";
            yield { type: "turn_end", meta: { subtype: m.subtype, turns: m.num_turns, cost: m.total_cost_usd, text: m.result, ...(failed ? { error: true } : {}) } };
          }
        }
      },
    };
  },
};
