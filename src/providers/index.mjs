import { claudeProvider } from "./claude.mjs";
import { openaiProvider, makeOpenAIProvider } from "./openai.mjs";

// Built-in provider registry. A `provider/model` ref (OpenClaw-style) selects a
// backend; each provider owns its own runtime (Claude via the Agent SDK to keep
// subscription auth; others via the raw MCP-client loop) behind the same
// normalized Session interface.
const PROVIDERS = {
  claude: claudeProvider,
  openai: openaiProvider,
};

export const RESERVED_PROVIDER_IDS = Object.keys(PROVIDERS);

// Resolve a provider from a `provider/model` ref. Beyond the built-ins, a
// `config.providers` entry defines an OpenAI-*compatible* endpoint (Gemini,
// Grok, DeepSeek, Ollama, OpenRouter, a local server…): { baseUrl, apiKeyEnv?,
// defaultModel? } — so `myllm/some-model` works with no new code.
export function resolveProvider(ref = "claude", cfg = null) {
  const id = String(ref).split("/")[0];
  const custom = cfg?.providers?.[id];
  // A config entry that shadows a built-in id is ambiguous — refuse it loudly
  // rather than silently routing to the wrong host (built-ins default to their
  // own endpoint and would ignore the configured baseUrl). The wizard also
  // rejects reserved names up front, so this only trips on hand-edited config.
  if (custom && PROVIDERS[id]) {
    throw new Error(`config.providers."${id}" collides with the built-in "${id}" provider — rename the endpoint`);
  }
  if (PROVIDERS[id]) return PROVIDERS[id];
  if (custom?.baseUrl) {
    return makeOpenAIProvider({
      id,
      baseURL: custom.baseUrl,
      apiKeyEnv: custom.apiKeyEnv ?? "OPENAI_API_KEY",
      defaultModel: custom.defaultModel,
    });
  }
  // Only advertise genuinely usable endpoints (a config entry without a baseUrl
  // is not resolvable).
  const validCustom = Object.entries(cfg?.providers ?? {}).filter(([, v]) => v?.baseUrl).map(([k]) => k);
  const known = [...RESERVED_PROVIDER_IDS, ...validCustom];
  throw new Error(`unknown model provider: "${id}" (have: ${known.join(", ")})`);
}

export function modelFromRef(ref) {
  const parts = String(ref ?? "").split("/");
  const model = parts.length > 1 ? parts.slice(1).join("/") : "";
  return model || undefined; // "openai/" (empty model segment) → undefined, not ""
}
