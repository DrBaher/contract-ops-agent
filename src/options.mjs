// Enclosure config for the Agent SDK session.
//
// Three layers (see docs/build-plan.md §1):
//  1. disallowedTools strips built-ins/harness tools from the model's context.
//     NOTE: ["*"] would strip the MCP tools too — the list must stay explicit.
//  2. canUseTool (src/gates.mjs) denies anything not mcp__contract-ops__*.
//  3. enclosure-assert refuses to start unless the init tool list is clean.
// No `allowedTools`: it auto-approves before canUseTool fires and would bypass
// the confirmation gates.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

export function resolveMcpServerPath() {
  if (process.env.LEGAL_HARNESS_MCP_PATH) return process.env.LEGAL_HARNESS_MCP_PATH;
  return require.resolve("contract-ops-mcp/contract-ops-mcp.mjs");
}

// The MCP server shells out to the suite CLIs, so anything in its env reaches
// those third-party binaries. Forward only what they need — never the harness's
// own secrets (e.g. ANTHROPIC_API_KEY). Least privilege at the tool boundary.
export function mcpServerEnv(workspace) {
  const allow = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "SHELL", "SystemRoot"];
  const env = { CONTRACT_OPS_MCP_BASE_DIR: workspace };
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

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
