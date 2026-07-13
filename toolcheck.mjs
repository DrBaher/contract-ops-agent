// Diagnostic: what tools does the session actually have under each config?
import { query } from "@anthropic-ai/claude-agent-sdk";

const MCP_SERVER = "/Users/bbot/contract-ops-mcp/contract-ops-mcp.mjs";
const mcpServers = {
  "contract-ops": {
    command: process.execPath,
    args: [MCP_SERVER],
    env: { ...process.env, CONTRACT_OPS_MCP_BASE_DIR: "/Users/bbot/legal-harness/workspace" },
  },
};

async function probe(label, extra) {
  for await (const m of query({
    prompt: "Say only: ok",
    options: { mcpServers, settingSources: [], permissionMode: "dontAsk", maxTurns: 1, ...extra },
  })) {
    if (m.type === "system" && m.subtype === "init") {
      console.log(`\n${label}:`);
      console.log("  tools:", JSON.stringify(m.tools));
      console.log("  mcp_servers:", JSON.stringify(m.mcp_servers));
    }
  }
}

await probe("A: disallowedTools ['*']", { disallowedTools: ["*"], allowedTools: ["mcp__contract-ops__*"] });
await probe("B: explicit disallow list", {
  disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "NotebookEdit", "Task", "TodoWrite", "AskUserQuestion", "Skill", "EnterPlanMode", "ExitPlanMode", "KillShell", "BashOutput", "ListMcpResources", "ReadMcpResource"],
  allowedTools: ["mcp__contract-ops__*"],
});
