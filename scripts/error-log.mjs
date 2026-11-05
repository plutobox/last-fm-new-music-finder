// Prints the errors a script handles and carries on from, so they can be read in the Actions log. That log is public, so
// callers pass only what's safe to show: never a username or a key. scrub() removes values that a message might echo.
// Prints the first MAX_PER_KIND of each kind, then only counts them, and ends with a total per kind.
const MAX_PER_KIND = 20;
const counts = new Map();

export function logError(kind, detail = "") {
  const n = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, n);
  if (n <= MAX_PER_KIND) console.log(`[error] ${kind}${detail ? `: ${detail}` : ""}`);
  if (n === MAX_PER_KIND) console.log(`[error] ${kind}: not printing more of these, only counting them`);
}

// The full detail, which can name a user, goes only in the encrypted database. Each script that makes Last.fm requests
// calls this once it has opened its database, which also deletes rows past the retention period. That needs no workflow
// of its own, which would rewrite the whole database just for this, and could bump a waiting fetch from the queue.
const ERROR_LOG_RETENTION_DAYS = 2;
let insertError = null;
export function saveErrorsTo(db) {
  db.exec("CREATE TABLE IF NOT EXISTS error_logs (logged_at TEXT, log TEXT NOT NULL)");
  if (!db.prepare("PRAGMA table_info(error_logs)").all().some((c) => c.name === "logged_at")) {
    db.exec("ALTER TABLE error_logs ADD COLUMN logged_at TEXT");
    // Rows from before this column start with their time.
    db.exec("UPDATE error_logs SET logged_at = substr(log, 1, 24), log = substr(log, 26)");
  }
  const cutoff = new Date(Date.now() - ERROR_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  db.prepare("DELETE FROM error_logs WHERE logged_at < ?").run(cutoff);
  insertError = db.prepare("INSERT INTO error_logs (logged_at, log) VALUES (?, ?)");
}
export function saveError(text) {
  insertError?.run(new Date().toISOString(), text);
}

// Blanks out each of the given values in a message.
export function scrub(text, values) {
  let out = String(text);
  for (const value of values) {
    if (value) out = out.split(String(value)).join("<hidden>");
  }
  return out;
}

process.on("exit", () => {
  if (!counts.size) return;
  const list = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} x ${kind}`);
  console.log(`Errors this run: ${list.join("; ")}`);
});
