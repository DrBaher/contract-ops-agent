import { createRequire } from "node:module";
import { VERSION } from "./version.mjs";
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
  const client = new Client({ name: "contract-ops-agent", version: VERSION }, { capabilities: {} });
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

// Env for sign-cli's MCP server: same least-privilege allowlist as the suite
// CLIs, plus sign-cli's own SIGN_* configuration variables (profiles, tokens).
export function signServerEnv() {
  const allow = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "SHELL", "SystemRoot"];
  const env = {};
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("SIGN_")) env[k] = process.env[k];
  return env;
}

// Mount sign-cli's own MCP server (signing modes — see src/signing.mjs).
// cwd = workspace so sign's cwd-relative DB (./data/sign.db) is the same one
// the human's sign-cli sees when run in the workspace.
export async function connectSign(workspace, mode) {
  if (!workspace) throw new Error("workspace is required");
  const { signServeArgs } = await import("./signing.mjs");
  const transport = new StdioClientTransport({
    command: "sign",
    args: signServeArgs(mode),
    cwd: workspace,
    env: signServerEnv(),
  });
  const client = new Client({ name: "contract-ops-agent", version: VERSION }, { capabilities: {} });
  try {
    await client.connect(transport);
    // sign-cli's catalog declares one outputSchema with type "array"
    // (signer_list), which the SDK's strict tools/list validator rejects —
    // and the rejection wedges the pending request. Fetch the list with a
    // permissive schema instead; inputSchemas pass through untouched.
    const { z } = await import("zod");
    const res = await client.request(
      { method: "tools/list", params: {} },
      z.looseObject({ tools: z.array(z.any()) }),
    );
    return {
      tools: res.tools,
      async call(name, args) {
        return client.callTool({ name, arguments: args ?? {} });
      },
      async close() {
        try { await client.close(); } catch { /* already closing */ }
      },
    };
  } catch (e) {
    try { await client.close(); } catch { /* not connected */ }
    throw e;
  }
}

// Flatten an MCP tool result's content blocks to a single text string for the
// model. Errors are surfaced as text (the caller sets is_error separately).
export function mcpResultText(result) {
  return (result?.content ?? [])
    .map((b) => (b?.type === "text" ? b.text : JSON.stringify(b)))
    .join("\n");
}
