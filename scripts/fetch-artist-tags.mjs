// Fetches each artist's top tags via artist.getTopTags, for the genre column in the public songs file.
// One request per artist, once ever, skipping artists whose songs all have one listener. Only adds to its own tables: tags,
// artist_tags and artist_tag_fetches. It never changes any existing table.
// Usage: node scripts/fetch-artist-tags.mjs --db db/users.db.age [--max-artists 5000] [--minutes 10]
//                                           [--concurrency 3] [--max-per-second 4]
//
// Needs LAST_FM_API_KEY. A ".age" --db also needs LAST_FM_AGE_IDENTITY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb, writeEncryptedDb, DEFAULT_PART_MB } from "./db-store.mjs";
import { createClient } from "./lastfm-client.mjs";
import { startProgress } from "./progress.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const apiKey = process.env.LAST_FM_API_KEY;
if (!apiKey) throw new Error("LAST_FM_API_KEY is not set");

const TAGS_PER_ARTIST = 5;
const MAX_CONSECUTIVE_FAILURES = 20;
const dbPath = args.db ?? "data/users.db";
const maxArtists = Number(args["max-artists"] ?? 5000);
const deadline = Date.now() + Number(args.minutes ?? 10) * 60_000;
const concurrency = Number(args.concurrency ?? 3);
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const encrypted = dbPath.endsWith(".age");
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

const client = createClient({
  apiKey,
  userAgent: process.env.LAST_FM_APPLICATION_NAME ?? "last-fm-new-music-finder",
  maxPerSecond: Number(args["max-per-second"] ?? 4),
});

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-tags-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));

const db = new DatabaseSync(localDb);
db.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = OFF;  -- a crash just means rerunning from the last published copy

  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS artist_tags (
    artist_id INTEGER NOT NULL REFERENCES artists (id),
    tag_id    INTEGER NOT NULL REFERENCES tags (id),
    count     INTEGER NOT NULL,  -- Last.fm's relative weight for this tag on this artist, 0..100
    PRIMARY KEY (artist_id, tag_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS artist_tag_fetches (
    artist_id  INTEGER PRIMARY KEY REFERENCES artists (id),
    fetched_at TEXT NOT NULL,
    error      TEXT
  );
`);

const q = {
  upsertTag: db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id"),
  insertArtistTag: db.prepare("INSERT INTO artist_tags (artist_id, tag_id, count) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
  markFetched: db.prepare("INSERT INTO artist_tag_fetches (artist_id, fetched_at, error) VALUES (?, ?, ?)"),
};

// Only artists with a song that has at least 2 listeners, the same rule as the public file. Most listeners first,
// so the songs people actually play get genres soonest.
db.exec(`
  CREATE TEMP TABLE eligible AS
  SELECT s.artist_id, sum(l.listeners) AS listeners
  FROM (
    SELECT song_id, count(*) AS listeners
    FROM (SELECT user_id, song_id FROM user_songs UNION SELECT user_id, song_id FROM user_loved_songs)
    GROUP BY song_id
    HAVING listeners >= 2
  ) l
  JOIN songs s ON s.id = l.song_id
  GROUP BY s.artist_id
`);
const queue = db.prepare(`
  SELECT a.id, a.name
  FROM eligible e
  JOIN artists a ON a.id = e.artist_id
  LEFT JOIN artist_tag_fetches f ON f.artist_id = a.id
  WHERE f.artist_id IS NULL
  ORDER BY e.listeners DESC, a.id
  LIMIT ?
`).all(maxArtists);
const countLeft = db.prepare(`
  SELECT count(*) AS n FROM eligible e LEFT JOIN artist_tag_fetches f ON f.artist_id = e.artist_id WHERE f.artist_id IS NULL
`);
console.log(`Queued ${queue.length} artists, out of ${countLeft.get().n} with a 2+ listener song still without tags`);

let fetched = 0, errored = 0, consecutiveFailures = 0, next = 0, stopped = false, stopReason = "queue finished";
const stop = (reason) => { if (!stopped) stopReason = reason; stopped = true; };

const progress = startProgress({
  label: "artists",
  total: queue.length,
  deadline,
  everySeconds: Number(args["log-seconds"] ?? 30),
  getCounts: () => ({
    done: fetched + errored,
    errors: errored,
    requests: client.stats.requests,
    rateLimited: client.stats.rateLimited,
  }),
});

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (!stopped && next < queue.length) {
    if (Date.now() >= deadline) { stop("time limit"); break; }
    const artist = queue[next++];
    const r = await client.apiGet({ method: "artist.getTopTags", artist: artist.name }, "toptags");
    if (r.error) {
      if (r.kind === "fatal") { stop(`Last.fm stopped us: ${r.error}`); break; }
      if (r.kind === "transient") {
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stop(`repeated failures (${r.error})`);
        continue; // left unfetched, so a later run retries this artist
      }
      q.markFetched.run(artist.id, new Date().toISOString(), r.error);
      errored++;
      consecutiveFailures = 0;
      continue;
    }
    const tags = (Array.isArray(r.tag) ? r.tag : r.tag ? [r.tag] : []).filter((t) => t.name).slice(0, TAGS_PER_ARTIST);
    db.exec("BEGIN");
    try {
      for (const t of tags) q.insertArtistTag.run(artist.id, q.upsertTag.get(t.name).id, Number(t.count) || 0);
      q.markFetched.run(artist.id, new Date().toISOString(), null);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    fetched++;
    consecutiveFailures = 0;
  }
}));

progress.stop();

const left = countLeft.get().n;
db.close();
console.log("Saving the database...");
if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), Number(args["part-mb"] ?? DEFAULT_PART_MB));
fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `Artist tags: ${fetched} fetched, ${errored} errored, ${left} left, ${client.stats.requests} requests ` +
  `(${client.stats.rateLimited} rate limited). Stopped: ${stopReason}`
);
if (!/queue finished|time limit/.test(stopReason)) console.log(`::warning::Stopped early: ${stopReason}`);
