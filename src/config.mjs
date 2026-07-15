import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_VERSION = 2;
const LEGACY_ANTHROPIC = "anthropic_api_key"; // v1 credentials field name

// All path helpers take an env object so tests can point HOME / XDG_CONFIG_HOME
// at a temp dir. Secrets live in a separate 0600 file, never in config.json.
export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "contract-ops-agent");
}
export function configPath(env = process.env) { return join(configDir(env), "config.json"); }
export function credentialsPath(env = process.env) { return join(configDir(env), "credentials.json"); }

// Distinguish "no config yet" from "config exists but won't parse" — the
// latter must never be silently treated as a first run (the wizard would
// overwrite the user's file).
export function configState(env = process.env) {
  const p = configPath(env);
  if (!existsSync(p)) return { status: "missing", config: null };
  try {
    return { status: "ok", config: JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) {
    return { status: "corrupt", config: null, error: e.message };
  }
}

export function loadConfig(env = process.env) {
  return configState(env).config;
}

export function saveConfig(cfg, env = process.env) {
  mkdirSync(configDir(env), { recursive: true });
  const { version, ...rest } = cfg;
  writeFileSync(configPath(env), JSON.stringify({ version: CONFIG_VERSION, ...rest }, null, 2) + "\n");
  return loadConfig(env);
}

export function isFirstRun(env = process.env) {
  return configState(env).status === "missing";
}

// --- secrets: stored keys, in one 0600 file keyed by env-var name ---
// e.g. { "ANTHROPIC_API_KEY": "sk-...", "OPENAI_API_KEY": "sk-..." } — so
// multiple providers' keys coexist. Never in config.json, never in a transcript.
function readCreds(env) {
  const p = credentialsPath(env);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // A truncated credentials file would otherwise degrade to "no key" with no
    // explanation — warn so the user knows why auth suddenly asks again.
    process.stderr.write(`[contract-ops-agent] warning: ${p} is unreadable (corrupt JSON); stored keys are being ignored. Re-run setup to store the key again.\n`);
    return {};
  }
}

export function saveApiKey(envKey, key, env = process.env) {
  mkdirSync(configDir(env), { recursive: true });
  const creds = readCreds(env);
  creds[envKey] = key;
  const p = credentialsPath(env);
  writeFileSync(p, JSON.stringify(creds) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch (e) {
    // A pre-existing loosely-permissioned file whose chmod fails would leave the
    // secret readable by others — surface it rather than swallow it.
    process.stderr.write(`[contract-ops-agent] warning: could not set 0600 permissions on ${p} (${e.message}); the stored key may be readable by others.\n`);
  }
}

export function loadApiKey(envKey = "ANTHROPIC_API_KEY", env = process.env) {
  const creds = readCreds(env);
  if (creds[envKey]) return creds[envKey];
  if (envKey === "ANTHROPIC_API_KEY" && creds[LEGACY_ANTHROPIC]) return creds[LEGACY_ANTHROPIC]; // v1
  return null;
}

// Apply a config's auth to the environment. `api-key` loads the stored key into
// the provider's env var (cfg.auth.envKey; defaults to ANTHROPIC_API_KEY for v1
// configs) only if not already set — an explicit env var always wins.
// `claude-code` / `env` store nothing; the backend inherits whatever is present.
export function applyAuth(cfg, env = process.env) {
  const mode = cfg?.auth?.mode ?? "inherit";
  if (mode === "api-key") {
    const envKey = cfg?.auth?.envKey ?? "ANTHROPIC_API_KEY";
    const key = loadApiKey(envKey, env);
    if (key && !env[envKey]) env[envKey] = key;
    return { mode, envKey, applied: !!(key && env[envKey]) };
  }
  return { mode, applied: false };
}
