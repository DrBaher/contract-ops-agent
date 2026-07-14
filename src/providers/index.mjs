import { claudeProvider } from "./claude.mjs";
import { openaiProvider } from "./openai.mjs";

// Provider registry. A `provider/model` ref (OpenClaw-style) selects a backend;
// each provider owns its own runtime (Claude via the Agent SDK to preserve
// subscription auth; others via the raw MCP-client loop) behind the same
// normalized Session interface.
const PROVIDERS = {
  claude: claudeProvider,
  openai: openaiProvider,
};

// Accept a bare id ("claude") or a "provider/model" ref ("claude/claude-opus-4-8").
export function resolveProvider(ref = "claude") {
  const id = String(ref).split("/")[0];
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown model provider: "${id}" (have: ${Object.keys(PROVIDERS).join(", ")})`);
  return provider;
}

export function modelFromRef(ref) {
  const parts = String(ref ?? "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : undefined;
}
