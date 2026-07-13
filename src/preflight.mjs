import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLIS } from "contract-ops-mcp/contract-ops-mcp.mjs";

const pexec = promisify(execFile);

export async function defaultCheckBin(bin) {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    await pexec(locator, [bin]);
    return true;
  } catch {
    return false;
  }
}

// Reports which suite CLIs are present, reusing the server's own CLIS table
// (importing the module does not start the server).
export async function preflight(clis = CLIS, checkBin = defaultCheckBin) {
  const rows = [];
  for (const [key, c] of Object.entries(clis)) {
    const installed = await checkBin(c.bin);
    rows.push(installed
      ? { cli: key, bin: c.bin, installed: true }
      : { cli: key, bin: c.bin, installed: false, install: c.install });
  }
  return rows;
}

export function renderPreflight(rows) {
  const missing = rows.filter((r) => !r.installed);
  const lines = [`contract-ops suite: ${rows.length - missing.length}/${rows.length} CLIs installed`];
  for (const m of missing) lines.push(`  missing ${m.bin} — install: ${m.install}`);
  return lines.join("\n");
}
