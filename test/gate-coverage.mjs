// Gate-coverage completeness: EVERY tool the real contract-ops server exposes
// must be classified by the harness gate — allowed (read-only) or confirmed
// (a write/consequential/sign act) — never falling through to the generic
// "unrecognized contract-ops tool" branch. This guarantees a server upgrade
// that adds a tool can't silently reach the model without the harness having
// an opinion on it, and it covers the legacy tools that had no direct test.
import test from "node:test";
import assert from "node:assert/strict";
import { connectMcp } from "../src/mcp-client.mjs";
import { decide, newSessionState, PREFIX } from "../src/gates.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("every server tool is classified by the gate (no unrecognized fallthrough)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "coa-gatecov-"));
  const mcp = await connectMcp(ws);
  try {
    assert.ok(mcp.tools.length >= 50, `expected the full tool set, got ${mcp.tools.length}`);
    const sess = newSessionState();
    const unclassified = [];
    for (const t of mcp.tools) {
      const d = decide(PREFIX + t.name, {}, sess);
      // read-only → allow; everything else → a specific confirm/deny. The one
      // thing that must NOT happen is the generic "unrecognized" fallback.
      if (/unrecognized contract-ops tool/.test(d.detail ?? "")) unclassified.push(t.name);
      assert.ok(["allow", "confirm", "deny"].includes(d.kind), `${t.name}: bad decision kind ${d.kind}`);
    }
    assert.deepEqual(unclassified, [], `tools with no gate classification: ${unclassified.join(", ")}`);

    // spot-check the previously-untested legacy tools land where they should
    const kindOf = (n, input = {}) => decide(PREFIX + n, input, newSessionState()).kind;
    for (const ro of ["audit_show", "verify_receipt", "template_vault_find", "template_vault_get", "contract_vault_query", "contract_vault_risk"]) {
      assert.equal(kindOf(ro), "allow", `${ro} should be read-only`);
    }
    assert.equal(kindOf("convert_to_pdf", { input: "a.docx" }), "confirm", "convert_to_pdf writes → confirm");
  } finally {
    await mcp.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
