import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_VERSION = 1;

// All path helpers take an env object so tests can point HOME / XDG_CONFIG_HOME
// at a temp dir. Secrets live in a separate 0600 file, never in config.json.
export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "legal-harness");
}
export function configPath(env = process.env) { return join(configDir(env), "config.json"); }
export function credentialsPath(env = process.env) { return join(configDir(env), "credentials.json"); }

export function loadConfig(env = process.env) {
  const p = configPath(env);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function saveConfig(cfg, env = process.env) {
  mkdirSync(configDir(env), { recursive: true });
  const { version, ...rest } = cfg;
  writeFileSync(configPath(env), JSON.stringify({ version: CONFIG_VERSION, ...rest }, null, 2) + "\n");
  return loadConfig(env);
}

export function isFirstRun(env = process.env) {
  return loadConfig(env) === null;
}

// --- secret: the stored API key, in its own 0600 file ---
export function saveApiKey(key, env = process.env) {
  mkdirSync(configDir(env), { recursive: true });
  const p = credentialsPath(env);
  writeFileSync(p, JSON.stringify({ anthropic_api_key: key }) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best effort on platforms without chmod */ }
}

export function loadApiKey(env = process.env) {
  const p = credentialsPath(env);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")).anthropic_api_key || null; } catch { return null; }
}

// Apply a config's auth to the environment. `api-key` loads the stored key into
// ANTHROPIC_API_KEY only if not already set (an explicit env var always wins).
// `claude-code` / `env` store nothing — the SDK inherits whatever is present.
export function applyAuth(cfg, env = process.env) {
  const mode = cfg?.auth?.mode ?? "inherit";
  if (mode === "api-key") {
    const key = loadApiKey(env);
    if (key && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = key;
    return { mode, applied: !!(key && env.ANTHROPIC_API_KEY) };
  }
  return { mode, applied: false };
}
