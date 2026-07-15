import { connectMcp, mcpResultText } from "./mcp-client.mjs";
import { makeCanUseTool, newSessionState, PREFIX } from "./gates.mjs";

// Direct-CLI passthrough: run ONE contract-ops tool and exit. This goes
// through the exact same MCP mount as the agent, so the server's own
// guarantees (workspace path confinement, the sign-mutation guard on `run`)
// hold unchanged — and the same gate policy applies: read-only tools run
// immediately, consequential ones (`fill_template`, `convert_to_pdf`, `run`)
// ask `confirm` first. Returns a process exit code: 0 ok, 1 tool error,
// 2 usage/declined.
export async function runTool({ workspace, name, args = {}, confirm, out = (s) => console.log(s), _connect = connectMcp }) {
  const mcp = await _connect(workspace);
  try {
    if (!name) {
      out("tools:");
      for (const t of mcp.tools) out(`  ${t.name.padEnd(24)} ${String(t.description ?? "").split("\n")[0]}`);
      out('\nrun one:  contract-ops-agent tool <name> \'{"param": "value"}\'');
      return 0;
    }
    if (!mcp.tools.some((t) => t.name === name)) {
      out(`unknown tool: ${name}\navailable: ${mcp.tools.map((t) => t.name).join(", ")}`);
      return 2;
    }
    const canUseTool = makeCanUseTool(newSessionState(), confirm, () => {});
    const outcome = await canUseTool(PREFIX + name, args);
    if (outcome.behavior !== "allow") {
      out(`declined: ${outcome.message ?? "not approved"}`);
      return 2;
    }
    const r = await mcp.call(name, outcome.updatedInput ?? args);
    out(mcpResultText(r));
    return r.isError === true ? 1 : 0;
  } finally {
    await mcp.close();
  }
}
