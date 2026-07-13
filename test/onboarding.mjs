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
    saveApiKey("sk-ant-secret", env);
    saveConfig({ workspace: "/w", auth: { mode: "api-key" } }, env);
    assert.equal(loadApiKey(env), "sk-ant-secret");
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
    saveApiKey("sk-stored", env);
    const e1 = { ...env };
    assert.deepEqual(applyAuth({ auth: { mode: "api-key" } }, e1), { mode: "api-key", applied: true });
    assert.equal(e1.ANTHROPIC_API_KEY, "sk-stored");
    // an explicit env key wins — stored key must not overwrite it
    const e2 = { ...env, ANTHROPIC_API_KEY: "sk-explicit" };
    applyAuth({ auth: { mode: "api-key" } }, e2);
    assert.equal(e2.ANTHROPIC_API_KEY, "sk-explicit");
    // claude-code / env store nothing
    const e3 = { ...env };
    assert.equal(applyAuth({ auth: { mode: "claude-code" } }, e3).applied, false);
    assert.equal(e3.ANTHROPIC_API_KEY, undefined);
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

test("S1: setup wizard — API key path stores the secret out-of-band, config is clean", async () => {
  const { env, dir } = tmpEnv();
  try {
    const ask = scriptAsk([
      "",              // workspace → default cwd
      "1",             // auth choice → API key
      "sk-ant-typed",  // the key
    ]);
    const cfg = await runSetup({ ask, env, cwd: "/contracts", checkBin: async () => true });
    assert.equal(cfg.workspace, "/contracts");
    assert.equal(cfg.auth.mode, "api-key");
    assert.equal(loadApiKey(env), "sk-ant-typed");
    assert.doesNotMatch(readFileSync(configPath(env), "utf8"), /sk-ant-typed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S2: setup wizard — Claude Code subscription path stores no secret", async () => {
  const { env, dir } = tmpEnv();
  try {
    const ask = scriptAsk(["/my/contracts", "2"]);
    const cfg = await runSetup({ ask, env, cwd: "/tmp", checkBin: async () => true });
    assert.equal(cfg.workspace, "/my/contracts");
    assert.equal(cfg.auth.mode, "claude-code");
    assert.equal(loadApiKey(env), null, "no credentials file for the subscription path");
    assert.ok(!existsSync(credentialsPath(env)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S3: setup wizard — an already-set env key is offered and adopted without prompting for one", async () => {
  const { env, dir } = tmpEnv({ ANTHROPIC_API_KEY: "sk-env" });
  try {
    const ask = scriptAsk(["", "y"]); // workspace default, then "use the env key? y"
    const cfg = await runSetup({ ask, env, cwd: "/c", checkBin: async () => true });
    assert.equal(cfg.auth.mode, "env");
    assert.equal(loadApiKey(env), null, "env mode stores nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S4: setup wizard offers a suite install when CLIs are missing", async () => {
  const { env, dir } = tmpEnv();
  try {
    const installed = [];
    const runInstall = async (cmd) => installed.push(cmd);
    // checkBin false → every CLI reports missing → install is offered; answer yes.
    const ask = scriptAsk(["y", "", "2"]); // install? y ; workspace default ; auth → claude-code
    await runSetup({ ask, env, cwd: "/c", checkBin: async () => false, runInstall });
    assert.deepEqual(installed, [SUITE_INSTALLER]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
