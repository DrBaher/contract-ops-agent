import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);

export function resolveMcpServerPath() {
  if (process.env.CONTRACT_OPS_AGENT_MCP_PATH) return process.env.CONTRACT_OPS_AGENT_MCP_PATH;
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

// Own the MCP connection to contract-ops-mcp: spawn it over stdio, list its
// tools, and call them. This is the ONLY source of tools the agent ever gets —
// the enclosure is a property of never mounting anything else.
export async function connectMcp(workspace) {
  if (!workspace) throw new Error("workspace is required");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolveMcpServerPath()],
    env: mcpServerEnv(workspace),
  });
  const client = new Client({ name: "contract-ops-agent", version: "0.3.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    tools, // [{ name, description, inputSchema }] — raw MCP names (no prefix)
    async call(name, args) {
      return client.callTool({ name, arguments: args ?? {} });
    },
    async close() {
      try { await client.close(); } catch { /* already closing */ }
    },
  };
}

// Flatten an MCP tool result's content blocks to a single text string for the
// model. Errors are surfaced as text (the caller sets is_error separately).
export function mcpResultText(result) {
  return (result?.content ?? [])
    .map((b) => (b?.type === "text" ? b.text : JSON.stringify(b)))
    .join("\n");
}
