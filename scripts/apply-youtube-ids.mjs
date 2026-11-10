// Saves the results file from fetch-youtube-ids.mjs into the database, as the one step that writes them.
// Usage: node scripts/apply-youtube-ids.mjs --results youtube-results.jsonl --db db/users.db.age
//
// A video found replaces whatever songs.youtube_search_id held. A search that found nothing never clears it. Applying
// the same file twice changes nothing. A ".age" --db needs LAST_FM_AGE_IDENTITY.
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
if (encrypted) await readEncryptedDb(dbPath, ageIdentity, localDb);
const db = new DatabaseSync(localDb);
db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;");

const columns = db.prepare("PRAGMA table_info(songs)").all().map((c) => c.name);
for (const column of ["youtube_id TEXT", "youtube_search_id TEXT", "youtube_search_source TEXT", "youtube_searched_at TEXT", "youtube_audio_searched_at TEXT"]) {
  if (!columns.includes(column.split(" ")[0])) db.exec(`ALTER TABLE songs ADD COLUMN ${column}`);
}

const save = db.prepare(`
  UPDATE songs SET
    youtube_search_id = COALESCE(?1, youtube_search_id),
    youtube_search_source = CASE WHEN ?1 IS NULL THEN youtube_search_source ELSE ?2 END,
    youtube_searched_at = ?3,
    youtube_audio_searched_at = ?3
  WHERE id = ?4
`);
const before = db.prepare("SELECT youtube_search_id AS id FROM songs WHERE id = ?");
let added = 0, replaced = 0, kept = 0, none = 0;
db.exec("BEGIN");
for (const r of results) {
  const old = before.get(r.song)?.id ?? null;
  save.run(r.video, r.source, r.at, r.song);
  if (!r.video) { if (old) kept++; else none++; }
  else if (!old) added++;
  else if (old !== r.video) replaced++;
}
db.exec("COMMIT");

// One-time cleanup, safe to run repeatedly, and can be removed once it reports 0. Before the fix for failed searches,
// a song's failed search could mark it as having no match. In a sample of 10, 6 found a good video when searched again.
const BEFORE_THE_FIX = "2026-11-05T16:00:00.000Z";
const cleared = db.prepare(`
  UPDATE songs SET youtube_searched_at = NULL, youtube_audio_searched_at = NULL
  WHERE youtube_id IS NULL AND youtube_search_id IS NULL AND youtube_searched_at < ?
`).run(BEFORE_THE_FIX).changes;
console.log(`Cleared ${cleared} "no match" marks from before the fix, so those songs get searched again.`);

console.log("Saving the database...");
db.exec("VACUUM");
db.close();
if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, localDb, Number(args["part-mb"] ?? DEFAULT_PART_MB));
fs.rmSync(workDir, { recursive: true, force: true });

console.log(`Applied ${results.length} YouTube results: ${added} new, ${replaced} replaced, ${kept} found nothing and kept their video, ${none} found nothing and have none.`);
