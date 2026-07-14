import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configDir, configPath, credentialsPath, loadConfig, saveConfig,
  isFirstRun, saveApiKey, loadApiKey, applyAuth, CONFIG_VERSION,
} from "../src/config.mjs";
import { diagnose, installPlan, renderDoctor, SUITE_INSTALLER } from "../src/doctor.mjs";
import { runSetup } from "../src/setup.mjs";

// Each test gets an isolated config home via a temp XDG_CONFIG_HOME.
function tmpEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lh-cfg-"));
  return { env: { XDG_CONFIG_HOME: dir, ...extra }, dir };
}

// scripted prompter
const scriptAsk = (answers) => {
  const q = [...answers];
  return async () => (q.length ? q.shift() : "");
};

test("C1: config round-trips and stamps the version", () => {
  const { env, dir } = tmpEnv();
  try {
    assert.equal(loadConfig(env), null);
    assert.ok(isFirstRun(env));
    saveConfig({ workspace: "/w", auth: { mode: "claude-code" } }, env);
    assert.ok(!isFirstRun(env));
    const c = loadConfig(env);
    assert.equal(c.version, CONFIG_VERSION);
    assert.equal(c.workspace, "/w");
    assert.equal(c.auth.mode, "claude-code");
    assert.ok(configPath(env).startsWith(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C2: API key lives only in the 0600 credentials file, never in config.json", () => {
  const { env, dir } = tmpEnv();
  try {
    saveApiKey("ANTHROPIC_API_KEY", "sk-ant-secret", env);
    saveConfig({ workspace: "/w", model: "claude", auth: { mode: "api-key", envKey: "ANTHROPIC_API_KEY" } }, env);
    assert.equal(loadApiKey("ANTHROPIC_API_KEY", env), "sk-ant-secret");
    const raw = readFileSync(configPath(env), "utf8");
    assert.doesNotMatch(raw, /sk-ant-secret/, "secret must not appear in config.json");
    if (process.platform !== "win32") {
      const mode = statSync(credentialsPath(env)).mode & 0o777;
      assert.equal(mode, 0o600, `credentials file must be 0600, got ${mode.toString(8)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: applyAuth loads the stored key only when env has none", () => {
  const { env, dir } = tmpEnv();
  try {
    saveApiKey("ANTHROPIC_API_KEY", "sk-stored", env);
    const e1 = { ...env };
    const r1 = applyAuth({ auth: { mode: "api-key", envKey: "ANTHROPIC_API_KEY" } }, e1);
    assert.equal(r1.mode, "api-key"); assert.equal(r1.applied, true);
    assert.equal(e1.ANTHROPIC_API_KEY, "sk-stored");
    // an explicit env key wins — stored key must not overwrite it
    const e2 = { ...env, ANTHROPIC_API_KEY: "sk-explicit" };
    applyAuth({ auth: { mode: "api-key", envKey: "ANTHROPIC_API_KEY" } }, e2);
    assert.equal(e2.ANTHROPIC_API_KEY, "sk-explicit");
    // a v1 config (no envKey) still resolves to ANTHROPIC_API_KEY
    const e1b = { ...env };
    applyAuth({ auth: { mode: "api-key" } }, e1b);
    assert.equal(e1b.ANTHROPIC_API_KEY, "sk-stored");
    // claude-code / env store nothing
    const e3 = { ...env };
    assert.equal(applyAuth({ auth: { mode: "claude-code" } }, e3).applied, false);
    assert.equal(e3.ANTHROPIC_API_KEY, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4: applyAuth + credentials are per-provider (OpenAI key coexists)", () => {
  const { env, dir } = tmpEnv();
  try {
    saveApiKey("OPENAI_API_KEY", "sk-oai", env);
    saveApiKey("ANTHROPIC_API_KEY", "sk-ant", env);
    // both keys live in the one 0600 file
    assert.equal(loadApiKey("OPENAI_API_KEY", env), "sk-oai");
    assert.equal(loadApiKey("ANTHROPIC_API_KEY", env), "sk-ant");
    // applyAuth targets exactly the configured provider's env var
    const e = { ...env };
    const r = applyAuth({ model: "openai/gpt-4o", auth: { mode: "api-key", envKey: "OPENAI_API_KEY" } }, e);
    assert.equal(r.envKey, "OPENAI_API_KEY");
    assert.equal(e.OPENAI_API_KEY, "sk-oai");
    assert.equal(e.ANTHROPIC_API_KEY, undefined, "must not touch the Anthropic var");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("D1: diagnose reports missing CLIs, PDF backend, and auth over a stubbed checker", async () => {
  const { env, dir } = tmpEnv();
  try {
    const clis = { a: { bin: "abin", install: "npm i -g a" }, b: { bin: "bbin", install: "pipx install b" } };
    const present = new Set(["abin", "soffice"]);
    const checkBin = async (bin) => present.has(bin);
    const diag = await diagnose({ clis, checkBin, env: { ...env } });
    assert.equal(diag.missing.length, 1);
    assert.equal(diag.missing[0].bin, "bbin");
    assert.equal(diag.pdfBackend, true);
    assert.equal(diag.auth.configured, null);
    const noPdf = await diagnose({ clis, checkBin: async (b) => b === "abin", env: { ...env } });
    assert.equal(noPdf.pdfBackend, false);
    const plan = installPlan(diag.missing);
    assert.equal(plan.suite, SUITE_INSTALLER);
    assert.equal(plan.perCli[0].command, "pipx install b");
    assert.match(renderDoctor(diag), /1\/2 installed|missing bbin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S1: setup wizard — Claude API key path stores the secret out-of-band", async () => {
  const { env, dir } = tmpEnv();
  try {
    const ask = scriptAsk([
      "",              // workspace → default cwd
      "1",             // provider → Claude
      "1",             // auth → API key
      "sk-ant-typed",  // the key
    ]);
    const cfg = await runSetup({ ask, env, cwd: "/contracts", checkBin: async () => true });
    assert.equal(cfg.workspace, "/contracts");
    assert.equal(cfg.model, "claude");
    assert.equal(cfg.auth.mode, "api-key");
    assert.equal(cfg.auth.envKey, "ANTHROPIC_API_KEY");
    assert.equal(loadApiKey("ANTHROPIC_API_KEY", env), "sk-ant-typed");
    assert.doesNotMatch(readFileSync(configPath(env), "utf8"), /sk-ant-typed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S2: setup wizard — Claude Code subscription path stores no secret", async () => {
  const { env, dir } = tmpEnv();
  try {
    const ask = scriptAsk(["/my/contracts", "1", "2"]); // workspace, provider→Claude, auth→subscription
    const cfg = await runSetup({ ask, env, cwd: "/tmp", checkBin: async () => true });
    assert.equal(cfg.workspace, "/my/contracts");
    assert.equal(cfg.model, "claude");
    assert.equal(cfg.auth.mode, "claude-code");
    assert.equal(loadApiKey("ANTHROPIC_API_KEY", env), null);
    assert.ok(!existsSync(credentialsPath(env)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S3: setup wizard — an already-set env key is offered and adopted", async () => {
  const { env, dir } = tmpEnv({ ANTHROPIC_API_KEY: "sk-env" });
  try {
    const ask = scriptAsk(["", "1", "y"]); // workspace, provider→Claude, "use the env key? y"
    const cfg = await runSetup({ ask, env, cwd: "/c", checkBin: async () => true });
    assert.equal(cfg.auth.mode, "env");
    assert.equal(cfg.auth.envKey, "ANTHROPIC_API_KEY");
    assert.equal(loadApiKey("ANTHROPIC_API_KEY", env), null, "env mode stores nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S4: setup wizard offers a suite install when CLIs are missing", async () => {
  const { env, dir } = tmpEnv();
  try {
    const installed = [];
    const runInstall = async (cmd) => installed.push(cmd);
    // checkBin false → every CLI reports missing → install is offered; answer yes.
    const ask = scriptAsk(["y", "", "1", "2"]); // install? ; workspace ; provider→Claude ; auth→subscription
    await runSetup({ ask, env, cwd: "/c", checkBin: async () => false, runInstall });
    assert.deepEqual(installed, [SUITE_INSTALLER]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S5: setup wizard — OpenAI path stores an OPENAI key + provider/model ref", async () => {
  const { env, dir } = tmpEnv();
  try {
    const ask = scriptAsk(["", "2", "sk-openai-typed", ""]); // workspace, provider→OpenAI, key, model→default
    const cfg = await runSetup({ ask, env, cwd: "/c", checkBin: async () => true });
    assert.equal(cfg.model, "openai/gpt-4o");
    assert.equal(cfg.auth.mode, "api-key");
    assert.equal(cfg.auth.envKey, "OPENAI_API_KEY");
    assert.equal(loadApiKey("OPENAI_API_KEY", env), "sk-openai-typed");
    assert.equal(loadApiKey("ANTHROPIC_API_KEY", env), null, "no Anthropic key for the OpenAI path");
    assert.doesNotMatch(readFileSync(configPath(env), "utf8"), /sk-openai-typed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S6: setup wizard — OpenAI-compatible endpoint records a providers block + keyed secret", async () => {
  const { env, dir } = tmpEnv();
  try {
    // workspace, provider→3(endpoint), name, baseUrl, key, model
    const ask = scriptAsk(["", "3", "grok", "https://api.x.ai/v1", "sk-grok", "grok-2"]);
    const cfg = await runSetup({ ask, env, cwd: "/c", checkBin: async () => true });
    assert.equal(cfg.model, "grok/grok-2");
    assert.deepEqual(cfg.providers.grok, { baseUrl: "https://api.x.ai/v1", apiKeyEnv: "GROK_API_KEY" });
    assert.equal(cfg.auth.mode, "api-key");
    assert.equal(cfg.auth.envKey, "GROK_API_KEY");
    assert.equal(loadApiKey("GROK_API_KEY", env), "sk-grok");
    assert.doesNotMatch(readFileSync(configPath(env), "utf8"), /sk-grok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
