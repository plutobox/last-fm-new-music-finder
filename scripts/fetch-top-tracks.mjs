// Fetches each crawled user's top songs via user.getTopTracks and stores them, normalized, in the users database.
// Two requests per user: period=overall and period=12month, first 50 songs each, no pagination.
// Usage: node scripts/fetch-top-tracks.mjs --db data/users.db.age [--max-users 5000] [--minutes 40]
//                                          [--part-mb 90]
//
// Order: LAST_FM_USERNAME first (similarity is measured against that user), then fewest friend-hops first.
// Each user is pulled once, ever: anyone with songs_fetched_at set is never requested again.
//
// Stops early, keeping its progress, on: --minutes or a run of API failures.
// A ".age" --db is split into files of at most --part-mb (see db-store.mjs).
//
// Needs LAST_FM_API_KEY. A ".age" --db also needs LAST_FM_AGE_IDENTITY.
// Logs only print counts, never usernames: Actions logs on a public repo are public.
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

const apiKey = process.env.LAST_FM_API_KEY;
if (!apiKey) throw new Error("LAST_FM_API_KEY is not set");

const PERIODS = [{ id: 1, name: "overall" }, { id: 2, name: "12month" }];
const LIMIT = 50;
const DELAY_MS = 250; // at most ~4 req/s, under Last.fm's ~5/s limit
const MAX_CONSECUTIVE_FAILURES = 20;
const PERMANENT_ERRORS = new Set([6, 17]); // user not found / private: specific to this user, don't retry
const FATAL_ERRORS = new Set([10, 26]); // bad or suspended API key: nothing else will work either

const dbPath = args.db ?? "data/users.db";
const maxUsers = Number(args["max-users"] ?? 5000);
const deadline = Date.now() + Number(args.minutes ?? 40) * 60_000;
const partMb = Number(args["part-mb"] ?? DEFAULT_PART_MB);
const me = process.env.LAST_FM_USERNAME?.trim();
const userAgent = process.env.LAST_FM_APPLICATION_NAME ?? "last-fm-new-music-finder";
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const encrypted = dbPath.endsWith(".age");
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist; run crawl-friends.mjs first`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ---- Last.fm ---------------------------------------------------------------------------------

let requests = 0;

// Returns { songs, total } or { error, kind: "permanent" | "fatal" | "transient" }.
async function getTopSongs(user, period) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method: "user.getTopTracks", user, period, limit: String(LIMIT), page: "1",
    api_key: apiKey, format: "json",
  });
  let last = "retries-exhausted";
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(DELAY_MS);
    requests++;
    let res, data;
    try {
      res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(30_000) });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      last = `network: ${e.name}`; // e.message could include the URL, which holds the API key
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (data.error) {
      const message = `${data.error}: ${data.message ?? ""}`.trim();
      if (PERMANENT_ERRORS.has(data.error)) return { error: message, kind: "permanent" };
      if (FATAL_ERRORS.has(data.error)) return { error: message, kind: "fatal" };
      last = `api error ${data.error}`;
    } else if (res.ok && data.toptracks) {
      const t = data.toptracks.track ?? [];
      return {
        songs: (Array.isArray(t) ? t : [t]).filter((x) => x.name && x.artist?.name).map((x) => ({
          name: x.name,
          artist: x.artist.name,
          mbid: x.mbid || null,
          duration: Number(x.duration) || null,
          plays: Number(x.playcount) || 0,
          rank: Number(x["@attr"]?.rank) || 0,
        })),
        total: Number(data.toptracks["@attr"]?.total) || 0,
      };
    } else {
      last = `http ${res.status}`;
    }
    await sleep(2000 * (attempt + 1)); // rate limited (29), temporary (8, 11, 16) or server trouble
  }
  return { error: last, kind: "transient" };
}

// ---- Per-user statistics ---------------------------------------------------------------------

// rows: [{ songId, artistId, plays }]
function computeStats(rows, total) {
  const plays = rows.map((r) => r.plays).sort((a, b) => b - a);
  const sum = plays.reduce((a, b) => a + b, 0);
  const n = plays.length;
  const byArtist = new Map();
  for (const r of rows) byArtist.set(r.artistId, (byArtist.get(r.artistId) ?? 0) + r.plays);
  let topArtistId = null, topArtistPlays = -1, hhi = 0;
  for (const [artistId, p] of byArtist) {
    if (p > topArtistPlays) { topArtistId = artistId; topArtistPlays = p; }
    if (sum > 0) hhi += (p / sum) ** 2;
  }
  const topSong = rows.reduce((best, r) => (best === null || r.plays > best.plays ? r : best), null);
  return {
    totalSongs: total,
    returned: n,
    topPlays: sum,
    topSongId: topSong?.songId ?? null,
    topSongPlays: topSong?.plays ?? null,
    topSongShare: sum ? topSong.plays / sum : null,
    meanPlays: n ? sum / n : null,
    medianPlays: n === 0 ? null : n % 2 ? plays[(n - 1) / 2] : (plays[n / 2 - 1] + plays[n / 2]) / 2,
    distinctArtists: byArtist.size,
    topArtistId,
    topArtistPlays: n ? topArtistPlays : null,
    topArtistShare: sum ? topArtistPlays / sum : null,
    artistHhi: sum ? hhi : null,
  };
}

// ---- Database --------------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-songs-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));

const db = new DatabaseSync(localDb);
db.exec(`
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = OFF;  -- a crash just means rerunning from the last published copy
  PRAGMA foreign_keys = OFF; -- so the users table can be rebuilt below
`);

const tx = (fn) => {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
};

// One-time migration: give users a stable integer id, so user_songs doesn't repeat every username.
// name stays UNIQUE, so crawl-friends.mjs and the friendships table keep working unchanged.
if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "id")) {
  const COLS = `name, realname, url, country, image_url, registered_at, subscriber, type, playcount, playlists,
    bootstrap, depth, discovered_via, discovered_at, details_updated_at, friends_total, crawled_at, crawl_error`;
  tx(() => db.exec(`
    CREATE TABLE users_new (
      id                 INTEGER PRIMARY KEY,
      name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
      realname           TEXT,
      url                TEXT,
      country            TEXT,
      image_url          TEXT,
      registered_at      INTEGER,
      subscriber         INTEGER,
      type               TEXT,
      playcount          INTEGER,
      playlists          INTEGER,
      bootstrap          INTEGER,
      depth              INTEGER,
      discovered_via     TEXT COLLATE NOCASE,
      discovered_at      TEXT NOT NULL,
      details_updated_at TEXT,
      friends_total      INTEGER,
      crawled_at         TEXT,
      crawl_error        TEXT,
      songs_fetched_at   TEXT,  -- when their top songs were fetched; NULL = not yet
      songs_error        TEXT
    );
    INSERT INTO users_new (${COLS}) SELECT ${COLS} FROM users ORDER BY rowid;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    CREATE INDEX users_uncrawled ON users (name) WHERE crawled_at IS NULL;
  `));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS periods (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS artists (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  -- Each song is stored once, however many users have it in their top 50.
  CREATE TABLE IF NOT EXISTS songs (
    id        INTEGER PRIMARY KEY,
    artist_id INTEGER NOT NULL REFERENCES artists (id),
    name      TEXT NOT NULL COLLATE NOCASE,
    mbid      TEXT,
    duration  INTEGER,  -- seconds
    UNIQUE (artist_id, name)
  );

  CREATE TABLE IF NOT EXISTS user_songs (
    user_id   INTEGER NOT NULL REFERENCES users (id),
    period_id INTEGER NOT NULL REFERENCES periods (id),
    rank      INTEGER NOT NULL,
    song_id   INTEGER NOT NULL REFERENCES songs (id),
    playcount INTEGER NOT NULL,
    PRIMARY KEY (user_id, period_id, rank)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS user_song_stats (
    user_id          INTEGER NOT NULL REFERENCES users (id),
    period_id        INTEGER NOT NULL REFERENCES periods (id),
    total_songs      INTEGER,  -- distinct songs they played in this period, per Last.fm
    songs_returned   INTEGER,  -- how many came back (at most 50)
    top_plays        INTEGER,  -- plays summed over those songs
    top_song_id      INTEGER REFERENCES songs (id),
    top_song_plays   INTEGER,
    top_song_share   REAL,     -- #1 song's share of top_plays
    mean_plays       REAL,
    median_plays     REAL,
    distinct_artists INTEGER,
    top_artist_id    INTEGER REFERENCES artists (id),
    top_artist_plays INTEGER,
    top_artist_share REAL,
    artist_hhi       REAL,     -- 0..1, higher = listening concentrated in fewer artists
    overlap_songs    INTEGER,  -- songs in both this user's overall and 12month lists
    shared_with_me   INTEGER,  -- songs also in LAST_FM_USERNAME's list for this period
    similarity_to_me REAL,     -- cosine similarity to LAST_FM_USERNAME on log(1 + plays), 0..1
    PRIMARY KEY (user_id, period_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS song_runs (
    id            INTEGER PRIMARY KEY,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    users_fetched INTEGER,
    users_errored INTEGER,
    requests      INTEGER,
    stop_reason   TEXT
  );

  -- Readable versions, computed on demand so they cost no storage.
  CREATE VIEW IF NOT EXISTS user_songs_named AS
    SELECT u.name AS user, p.name AS period, us.rank, a.name AS artist, s.name AS song, us.playcount
    FROM user_songs us
    JOIN users u ON u.id = us.user_id
    JOIN periods p ON p.id = us.period_id
    JOIN songs s ON s.id = us.song_id
    JOIN artists a ON a.id = s.artist_id;

  CREATE VIEW IF NOT EXISTS song_stats AS
    SELECT s.id, a.name AS artist, s.name AS song, p.name AS period,
           count(*) AS listeners_in_sample, sum(us.playcount) AS total_plays, avg(us.rank) AS avg_rank
    FROM user_songs us
    JOIN songs s ON s.id = us.song_id
    JOIN artists a ON a.id = s.artist_id
    JOIN periods p ON p.id = us.period_id
    GROUP BY s.id, p.id;
`);

{
  const insertPeriod = db.prepare("INSERT INTO periods (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING");
  for (const p of PERIODS) insertPeriod.run(p.id, p.name);
}

const q = {
  upsertArtist: db.prepare(`
    INSERT INTO artists (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id
  `),
  upsertSong: db.prepare(`
    INSERT INTO songs (artist_id, name, mbid, duration) VALUES (?, ?, ?, ?)
    ON CONFLICT (artist_id, name) DO UPDATE SET
      mbid = COALESCE(excluded.mbid, mbid), duration = COALESCE(excluded.duration, duration)
    RETURNING id
  `),
  // ON CONFLICT: the primary key includes rank, so a repeated rank in a response can't fail the whole user.
  insertUserSong: db.prepare(`
    INSERT INTO user_songs (user_id, period_id, rank, song_id, playcount) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `),
  insertStats: db.prepare(`
    INSERT INTO user_song_stats (user_id, period_id, total_songs, songs_returned, top_plays, top_song_id,
      top_song_plays, top_song_share, mean_plays, median_plays, distinct_artists, top_artist_id,
      top_artist_plays, top_artist_share, artist_hhi, overlap_songs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  markFetched: db.prepare("UPDATE users SET songs_fetched_at = ?, songs_error = ? WHERE id = ?"),
  pageCount: db.prepare("PRAGMA page_count"),
  pageSize: db.prepare("PRAGMA page_size"),
};

const dbBytes = () => q.pageCount.get().page_count * q.pageSize.get().page_size;

function saveUser(userId, results) {
  tx(() => {
    const rows = {};
    for (const period of PERIODS) {
      rows[period.id] = results[period.id].songs.map((s) => {
        const artistId = q.upsertArtist.get(s.artist).id;
        const songId = q.upsertSong.get(artistId, s.name, s.mbid, s.duration).id;
        q.insertUserSong.run(userId, period.id, s.rank, songId, s.plays);
        return { songId, artistId, plays: s.plays };
      });
    }
    const [a, b] = PERIODS.map((p) => new Set(rows[p.id].map((r) => r.songId)));
    const overlap = [...a].filter((id) => b.has(id)).length;
    for (const period of PERIODS) {
      const s = computeStats(rows[period.id], results[period.id].total);
      q.insertStats.run(
        userId, period.id, s.totalSongs, s.returned, s.topPlays, s.topSongId, s.topSongPlays, s.topSongShare,
        s.meanPlays, s.medianPlays, s.distinctArtists, s.topArtistId, s.topArtistPlays, s.topArtistShare,
        s.artistHhi, overlap,
      );
    }
    q.markFetched.run(now(), null, userId);
  });
}

// Scores every fetched user against LAST_FM_USERNAME, including those added this run.
function updateSimilarity() {
  if (!me) return;
  const myId = db.prepare("SELECT id FROM users WHERE name = ?").get(me)?.id;
  const update = db.prepare(
    "UPDATE user_song_stats SET shared_with_me = ?, similarity_to_me = ? WHERE user_id = ? AND period_id = ?"
  );
  for (const period of PERIODS) {
    const mine = new Map();
    const myRows = db.prepare("SELECT song_id, playcount FROM user_songs WHERE user_id = ? AND period_id = ?");
    for (const r of myRows.iterate(myId, period.id)) mine.set(r.song_id, Math.log1p(r.playcount));
    const myNorm = Math.sqrt([...mine.values()].reduce((a, w) => a + w * w, 0));
    if (myNorm === 0) continue;

    const scores = [];
    let current = null, dot = 0, norm2 = 0, shared = 0;
    const flush = () => {
      if (current !== null) scores.push([shared, norm2 ? dot / (myNorm * Math.sqrt(norm2)) : 0, current]);
    };
    const rows = db.prepare("SELECT user_id, song_id, playcount FROM user_songs WHERE period_id = ? ORDER BY user_id");
    for (const r of rows.iterate(period.id)) {
      if (r.user_id !== current) { flush(); current = r.user_id; dot = 0; norm2 = 0; shared = 0; }
      const w = Math.log1p(r.playcount);
      norm2 += w * w;
      const m = mine.get(r.song_id);
      if (m !== undefined) { dot += w * m; shared++; }
    }
    flush();
    tx(() => { for (const [s, sim, userId] of scores) update.run(s, sim, userId, period.id); });
  }
}

// ---- Fetch -----------------------------------------------------------------------------------

const startedAt = now();
const runId = db.prepare("INSERT INTO song_runs (started_at) VALUES (?)").run(startedAt).lastInsertRowid;
if (me) {
  db.prepare("INSERT INTO users (name, depth, discovered_at) VALUES (?, 0, ?) ON CONFLICT (name) DO NOTHING").run(me, startedAt);
} else {
  console.log("::warning::LAST_FM_USERNAME is not set, so similarity won't be calculated");
}

const queue = db.prepare(`
  SELECT id, name FROM users
  WHERE songs_fetched_at IS NULL
  ORDER BY name = ? COLLATE NOCASE DESC, depth, random()
  LIMIT ?
`).all(me ?? "", maxUsers);
console.log(`Queued ${queue.length} users`);

let fetched = 0, errored = 0, consecutiveFailures = 0, stopReason = "queue finished";

outer: for (const user of queue) {
  if (Date.now() >= deadline) { stopReason = "time limit"; break; }

  const results = {};
  for (const period of PERIODS) {
    const r = await getTopSongs(user.name, period.name);
    if (r.kind === "fatal") { stopReason = `api key problem (${r.error})`; break outer; }
    if (r.kind === "permanent") {
      q.markFetched.run(now(), r.error, user.id);
      errored++;
      consecutiveFailures = 0;
      continue outer;
    }
    if (r.kind === "transient") {
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { stopReason = `repeated failures (${r.error})`; break outer; }
      continue outer; // left unfetched, so a later run retries this user
    }
    results[period.id] = r;
  }
  saveUser(user.id, results);
  fetched++;
  consecutiveFailures = 0;
  if (fetched % 250 === 0) {
    console.log(`fetched ${fetched}, errors ${errored}, requests ${requests}, db ${(dbBytes() / 1048576).toFixed(1)} MB`);
  }
}

if (fetched > 0) updateSimilarity();

db.prepare(
  "UPDATE song_runs SET finished_at = ?, users_fetched = ?, users_errored = ?, requests = ?, stop_reason = ? WHERE id = ?"
).run(now(), fetched, errored, requests, stopReason, runId);

const count = (sql) => db.prepare(sql).get().n;
const remaining = count("SELECT count(*) AS n FROM users WHERE songs_fetched_at IS NULL");
const totalSongs = count("SELECT count(*) AS n FROM songs");
const totalArtists = count("SELECT count(*) AS n FROM artists");
const totalRows = count("SELECT count(*) AS n FROM user_songs");
db.exec("VACUUM");
const finalBytes = dbBytes();
db.close();

const files = encrypted ? await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), partMb) : 1;
fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `Fetched ${fetched} users (${errored} errored, ${remaining} not fetched yet) with ${requests} requests. ` +
  `Database: ${totalSongs} songs, ${totalArtists} artists, ${totalRows} user-song rows, ` +
  `${(finalBytes / 1048576).toFixed(1)} MB in ${files} file(s). Stopped: ${stopReason}`
);
if (!/queue finished|time limit/.test(stopReason)) console.log(`::warning::Stopped early: ${stopReason}`);
