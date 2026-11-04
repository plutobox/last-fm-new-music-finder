// Fetches each song's details via track.getInfo: url, global listeners and plays, album, tags and wiki date.
// The wiki text is deliberately not stored: it's most of the response's size and nothing here uses it.
// One request per song, once ever, most-listened songs first.
// Usage: node scripts/fetch-track-info.mjs --db db/users.db.age [--max-songs 20000] [--minutes 15]
//                                          [--concurrency 3] [--max-per-second 4]
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

const MAX_CONSECUTIVE_FAILURES = 20;
const IMAGE_SIZES = ["small", "medium", "large", "extralarge"];
const SONG_COLUMNS = [
  ["url", "TEXT"],
  ["listeners", "INTEGER"], // across all of Last.fm
  ["plays", "INTEGER"], // across all of Last.fm
  ["streamable", "INTEGER"],
  ["full_track", "INTEGER"],
  ["album_id", "INTEGER"],
  ["album_position", "INTEGER"],
  ["wiki_published", "TEXT"], // as Last.fm writes it, like "11 Sep 2008, 13:03"
  ["info_fetched_at", "TEXT"], // set once requested, and the song is never requested again
  ["info_error", "TEXT"],
];

const dbPath = args.db ?? "data/users.db";
const maxSongs = Number(args["max-songs"] ?? 20000);
const deadline = Date.now() + Number(args.minutes ?? 15) * 60_000;
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-tracks-"));
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

  -- album_artist is text because an album's artist, like "Various Artists", may not be in the artists table.
  CREATE TABLE IF NOT EXISTS albums (
    id               INTEGER PRIMARY KEY,
    album_artist     TEXT NOT NULL COLLATE NOCASE,
    title            TEXT NOT NULL COLLATE NOCASE,
    mbid             TEXT,
    url              TEXT,
    ${IMAGE_SIZES.map((s) => `image_${s} TEXT`).join(",\n    ")},
    UNIQUE (album_artist, title)
  );

  CREATE TABLE IF NOT EXISTS song_tags (
    song_id  INTEGER NOT NULL REFERENCES songs (id),
    tag_id   INTEGER NOT NULL REFERENCES tags (id),
    position INTEGER NOT NULL,  -- 1 = the song's strongest tag
    PRIMARY KEY (song_id, tag_id)
  ) WITHOUT ROWID;
`);

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
for (const [name, type] of SONG_COLUMNS) {
  if (!columnsOf("songs").includes(name)) db.exec(`ALTER TABLE songs ADD COLUMN ${name} ${type}`);
}
for (const name of ["mbid", "url"]) {
  if (!columnsOf("artists").includes(name)) db.exec(`ALTER TABLE artists ADD COLUMN ${name} TEXT`);
}
if (!columnsOf("tags").includes("url")) db.exec("ALTER TABLE tags ADD COLUMN url TEXT");
for (const name of ["wiki_summary", "wiki_content"]) {
  if (columnsOf("songs").includes(name)) db.exec(`ALTER TABLE songs DROP COLUMN ${name}`); // an earlier version stored these
}

const q = {
  upsertTag: db.prepare(`
    INSERT INTO tags (name, url) VALUES (?, ?)
    ON CONFLICT (name) DO UPDATE SET url = COALESCE(excluded.url, url)
    RETURNING id
  `),
  insertSongTag: db.prepare("INSERT INTO song_tags (song_id, tag_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
  upsertAlbum: db.prepare(`
    INSERT INTO albums (album_artist, title, mbid, url, ${IMAGE_SIZES.map((s) => `image_${s}`).join(", ")})
    VALUES (?, ?, ?, ?, ${IMAGE_SIZES.map(() => "?").join(", ")})
    ON CONFLICT (album_artist, title) DO UPDATE SET
      mbid = COALESCE(excluded.mbid, mbid), url = COALESCE(excluded.url, url),
      ${IMAGE_SIZES.map((s) => `image_${s} = COALESCE(excluded.image_${s}, image_${s})`).join(", ")}
    RETURNING id
  `),
  updateArtist: db.prepare(`
    UPDATE artists SET mbid = COALESCE(?, mbid), url = COALESCE(?, url)
    WHERE id = (SELECT artist_id FROM songs WHERE id = ?)
  `),
  updateSong: db.prepare(`
    UPDATE songs SET mbid = COALESCE(?, mbid), duration = COALESCE(?, duration), url = ?, listeners = ?, plays = ?,
      streamable = ?, full_track = ?, album_id = ?, album_position = ?,
      wiki_published = ?, info_fetched_at = ?, info_error = NULL
    WHERE id = ?
  `),
  markError: db.prepare("UPDATE songs SET info_fetched_at = ?, info_error = ? WHERE id = ?"),
};

const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const int = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function saveAlbum(album) {
  if (!album?.title) return null;
  const images = Object.fromEntries(asArray(album.image).map((i) => [i.size, i["#text"] || null]));
  return q.upsertAlbum.get(
    album.artist ?? "", album.title, album.mbid || null, album.url || null, ...IMAGE_SIZES.map((s) => images[s] ?? null),
  ).id;
}

function saveSong(songId, t) {
  db.exec("BEGIN");
  try {
    asArray(t.toptags?.tag).filter((x) => x.name).forEach((x, i) => {
      q.insertSongTag.run(songId, q.upsertTag.get(x.name, x.url || null).id, i + 1);
    });
    q.updateArtist.run(t.artist?.mbid || null, t.artist?.url || null, songId);
    const durationMs = int(t.duration); // track.getInfo gives milliseconds; songs.duration is in seconds
    q.updateSong.run(
      t.mbid || null, durationMs ? Math.round(durationMs / 1000) : null, t.url || null,
      int(t.listeners), int(t.playcount), int(t.streamable?.["#text"]), int(t.streamable?.fulltrack),
      saveAlbum(t.album), int(t.album?.["@attr"]?.position),
      t.wiki?.published || null, new Date().toISOString(), songId,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Most-listened first, so the songs people actually play get details soonest.
const queue = db.prepare(`
  SELECT s.id, s.name AS song, a.name AS artist
  FROM songs s
  JOIN artists a ON a.id = s.artist_id
  LEFT JOIN (
    SELECT song_id, count(*) AS n
    FROM (SELECT song_id FROM user_songs UNION ALL SELECT song_id FROM user_loved_songs)
    GROUP BY song_id
  ) p ON p.song_id = s.id
  WHERE s.info_fetched_at IS NULL
  ORDER BY coalesce(p.n, 0) DESC, s.id
  LIMIT ?
`).all(maxSongs);
const countLeft = db.prepare("SELECT count(*) AS n FROM songs WHERE info_fetched_at IS NULL");
console.log(`Queued ${queue.length} songs, out of ${countLeft.get().n} still without details`);

let fetched = 0, errored = 0, consecutiveFailures = 0, next = 0, stopped = false, stopReason = "queue finished";
const stop = (reason) => { if (!stopped) stopReason = reason; stopped = true; };

const progress = startProgress({
  label: "songs",
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
    const song = queue[next++];
    const r = await client.apiGet({ method: "track.getInfo", artist: song.artist, track: song.song }, "track");
    if (r.error) {
      if (r.kind === "fatal") { stop(`Last.fm stopped us: ${r.error}`); break; }
      if (r.kind === "transient") {
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stop(`repeated failures (${r.error})`);
        continue; // left unfetched, so a later run retries this song
      }
      q.markError.run(new Date().toISOString(), r.error, song.id);
      errored++;
      consecutiveFailures = 0;
      continue;
    }
    saveSong(song.id, r);
    fetched++;
    consecutiveFailures = 0;
  }
}));
progress.stop();

const left = countLeft.get().n;
console.log("Saving the database...");
db.exec("VACUUM");
db.close();
if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), Number(args["part-mb"] ?? DEFAULT_PART_MB));
fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `Song details: ${fetched} fetched, ${errored} errored, ${left} left, ${client.stats.requests} requests ` +
  `(${client.stats.rateLimited} rate limited). Stopped: ${stopReason}`
);
if (!/queue finished|time limit/.test(stopReason)) console.log(`::warning::Stopped early: ${stopReason}`);
