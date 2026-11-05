// Saves the results file from fetch-youtube-ids.mjs into the database, as the one step that writes them.
// Usage: node scripts/apply-youtube-ids.mjs --results youtube-results.jsonl --db db/users.db.age
//
// Only touches songs that are still waiting. A song that gained a video in the meantime keeps it. Applying the same
// file twice changes nothing. A ".age" --db needs LAST_FM_AGE_IDENTITY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb, writeEncryptedDb, DEFAULT_PART_MB } from "./db-store.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const resultsFile = args.results;
if (!resultsFile) throw new Error("--results is required");
const dbPath = args.db ?? "data/users.db";
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const encrypted = dbPath.endsWith(".age");
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

const results = fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-apply-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));
const db = new DatabaseSync(localDb);
db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;");

const columns = db.prepare("PRAGMA table_info(songs)").all().map((c) => c.name);
for (const column of ["youtube_id TEXT", "youtube_search_id TEXT", "youtube_search_source TEXT", "youtube_searched_at TEXT"]) {
  if (!columns.includes(column.split(" ")[0])) db.exec(`ALTER TABLE songs ADD COLUMN ${column}`);
}

const save = db.prepare(`
  UPDATE songs SET youtube_search_id = ?, youtube_search_source = ?, youtube_searched_at = ?
  WHERE id = ? AND youtube_id IS NULL AND youtube_search_id IS NULL AND youtube_searched_at IS NULL
`);
let applied = 0;
db.exec("BEGIN");
for (const r of results) applied += Number(save.run(r.video, r.source, r.at, r.song).changes);
db.exec("COMMIT");

console.log("Saving the database...");
db.exec("VACUUM");
db.close();
if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), Number(args["part-mb"] ?? DEFAULT_PART_MB));
fs.rmSync(workDir, { recursive: true, force: true });

console.log(`Applied ${applied} of ${results.length} YouTube results; ${results.length - applied} were no longer waiting.`);
