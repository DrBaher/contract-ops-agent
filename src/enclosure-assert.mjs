import { PREFIX } from "./gates.mjs";
import { SIGN_PREFIX, allowedSignTools } from "./signing.mjs";

// Layer 3 of the enclosure: refuse to run unless the mounted tool list is
// exactly the contract-ops tools — plus, when a signing mode is active, the
// EXACT sign tools that mode allows (an unexpected sign tool is a breach even
// with signing on). Called with the SDK's `init` system message.
export function assertEnclosure(initMessage, signingMode = "off") {
  const tools = initMessage?.tools ?? [];
  if (tools.length === 0) {
    throw new Error(
      "Enclosure check failed: zero tools mounted. (Likely cause: disallowedTools ['*'] strips MCP tools too, or the MCP server failed to start.)",
    );
  }
  const signAllowed = new Set(allowedSignTools(signingMode).map((n) => SIGN_PREFIX + n));
  const leaked = tools.filter((n) => !n.startsWith(PREFIX) && !signAllowed.has(n));
  if (leaked.length > 0) {
    throw new Error(`Enclosure breach: unexpected tools mounted: ${leaked.join(", ")}`);
  }
  return tools.length;
}
