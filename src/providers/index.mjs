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

// Resolve a provider from a `provider/model` ref. Beyond the built-ins, a
// `config.providers` entry defines an OpenAI-*compatible* endpoint (Gemini,
// Grok, DeepSeek, Ollama, OpenRouter, a local server…): { baseUrl, apiKeyEnv?,
// defaultModel? }. So `myllm/some-model` with a matching config entry works with
// no new code — the whole long tail, one adapter.
export function resolveProvider(ref = "claude", cfg = null) {
  const id = String(ref).split("/")[0];
  if (PROVIDERS[id]) return PROVIDERS[id];
  const custom = cfg?.providers?.[id];
  if (custom?.baseUrl) {
    return makeOpenAIProvider({
      id,
      baseURL: custom.baseUrl,
      apiKeyEnv: custom.apiKeyEnv ?? "OPENAI_API_KEY",
      defaultModel: custom.defaultModel,
    });
  }
  const known = [...Object.keys(PROVIDERS), ...Object.keys(cfg?.providers ?? {})];
  throw new Error(`unknown model provider: "${id}" (have: ${known.join(", ")})`);
}

export function modelFromRef(ref) {
  const parts = String(ref ?? "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : undefined;
}
