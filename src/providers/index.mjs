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

// Preset OpenAI-compatible endpoints: `gemini/<model>`, `ollama/<model>` etc.
// work with zero config. Unlike the core built-ins these are just endpoint
// defaults, so a `config.providers` entry with the same id deliberately
// OVERRIDES the preset (point "gemini" at a proxy, "ollama" at another host…).
// `keyOptional` marks endpoints that can run without a key (local servers).
export const PRESET_ENDPOINTS = {
  gemini:     { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKeyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash" },
  grok:       { baseURL: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", defaultModel: "grok-3" },
  deepseek:   { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  ollama:     { baseURL: "http://localhost:11434/v1", apiKeyEnv: "OLLAMA_API_KEY", keyOptional: true },
};

// Resolve a provider from a `provider/model` ref. Beyond the built-ins and
// presets, a `config.providers` entry defines an OpenAI-*compatible* endpoint
// (a proxy, a local server, anything else…): { baseUrl, apiKeyEnv?,
// defaultModel? } — so `myllm/some-model` works with no new code.
export function resolveProvider(ref = "claude", cfg = null) {
  const id = String(ref).split("/")[0];
  const custom = cfg?.providers?.[id];
  // A config entry that shadows a CORE built-in id is ambiguous — refuse it
  // loudly rather than silently routing to the wrong host (claude/openai
  // default to their own endpoint and would ignore the configured baseUrl).
  // The wizard also rejects reserved names up front, so this only trips on
  // hand-edited config. Presets are NOT guarded: overriding them is the point.
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
      keyOptional: custom.keyOptional === true,
    });
  }
  if (PRESET_ENDPOINTS[id]) {
    const p = PRESET_ENDPOINTS[id];
    return makeOpenAIProvider({ id, baseURL: p.baseURL, apiKeyEnv: p.apiKeyEnv, defaultModel: p.defaultModel, keyOptional: p.keyOptional === true });
  }
  // Only advertise genuinely usable endpoints (a config entry without a baseUrl
  // is not resolvable).
  const validCustom = Object.entries(cfg?.providers ?? {}).filter(([, v]) => v?.baseUrl).map(([k]) => k);
  const known = [...new Set([...RESERVED_PROVIDER_IDS, ...validCustom, ...Object.keys(PRESET_ENDPOINTS)])];
  throw new Error(`unknown model provider: "${id}" (have: ${known.join(", ")})`);
}

export function modelFromRef(ref) {
  const parts = String(ref ?? "").split("/");
  const model = parts.length > 1 ? parts.slice(1).join("/") : "";
  return model || undefined; // "openai/" (empty model segment) → undefined, not ""
}
