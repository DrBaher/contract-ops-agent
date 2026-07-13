import { PREFIX } from "./gates.mjs";

// Layer 3 of the enclosure: refuse to run unless the mounted tool list is
// exactly the contract-ops tools. Called with the SDK's `init` system message.
export function assertEnclosure(initMessage) {
  const tools = initMessage?.tools ?? [];
  if (tools.length === 0) {
    throw new Error(
      "Enclosure check failed: zero tools mounted. (Likely cause: disallowedTools ['*'] strips MCP tools too, or the MCP server failed to start.)",
    );
  }
  const leaked = tools.filter((n) => !n.startsWith(PREFIX));
  if (leaked.length > 0) {
    throw new Error(`Enclosure breach: non-contract-ops tools mounted: ${leaked.join(", ")}`);
  }
  return tools.length;
}
