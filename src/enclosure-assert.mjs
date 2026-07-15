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
  // When a signing mode is active, the sign tools MUST actually be present —
  // otherwise the session would advertise "sign:<mode>" while silently having
  // no signing capability (e.g. the Agent SDK's strict MCP client rejecting a
  // sign server whose schema it won't accept). Fail loudly rather than lie.
  if (signingMode !== "off" && !tools.some((n) => n.startsWith(SIGN_PREFIX))) {
    throw new Error(
      `Signing mode "${signingMode}" is active but no sign tools mounted — the sign server did not register. ` +
      `Check that sign-cli is installed and current (older builds expose an MCP schema the Agent SDK rejects). ` +
      `Update sign-cli, or set signing.mode to off.`,
    );
  }
  return tools.length;
}
