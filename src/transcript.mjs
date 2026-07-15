import { appendFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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

// Load what --resume needs from a prior transcript: the conversation's
// user/assistant turns (to seed loop providers) and the last recorded SDK
// session id (to resume the Claude provider natively). `arg` is a transcript
// path, or "last" to pick the newest .jsonl in `dir`.
export function loadResume(dir, arg = "last") {
  let file = arg;
  if (arg === "last" || arg === "") {
    if (!existsSync(dir)) throw new Error(`no transcripts directory at ${dir}`);
    const names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
    if (!names.length) throw new Error(`no transcripts to resume in ${dir}`);
    file = join(dir, names[names.length - 1]);
  }
  const seed = [];
  let sessionId = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // a torn last line is fine
    if (rec.type === "user" && rec.text) seed.push({ role: "user", text: rec.text });
    else if (rec.type === "assistant" && rec.text) seed.push({ role: "assistant", text: rec.text });
    else if (rec.type === "init" && rec.sessionId) sessionId = rec.sessionId;
  }
  if (!seed.length && !sessionId) throw new Error(`${file} has no resumable conversation`);
  return { file, seed, sessionId };
}
