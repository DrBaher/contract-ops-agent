import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Append-only JSONL session log. Created lazily so a session with no events
// leaves no file behind. A filesystem error disables transcription with a
// single warning instead of crashing the session.
export class Transcript {
  constructor(dir, now = new Date()) {
    this.dir = dir ?? "transcripts";
    this.path = join(this.dir, `${now.toISOString().replace(/[:.]/g, "-")}.jsonl`);
    this._created = false;
    this._disabled = false;
    this._warn = (msg) => process.stderr.write(msg + "\n");
  }

  write(event) {
    if (this._disabled) return;
    try {
      if (!this._created) {
        mkdirSync(this.dir, { recursive: true });
        // Self-ignore so contract text never lands in a user's git repo,
        // regardless of their own .gitignore.
        try { writeFileSync(join(this.dir, ".gitignore"), "*\n", { flag: "wx" }); } catch { /* already present */ }
        this._created = true;
      }
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
    } catch (err) {
      this._disabled = true;
      this._warn(`[contract-ops-agent] transcript disabled — cannot write ${this.path}: ${err.message}`);
    }
  }
}
