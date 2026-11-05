// Fetches each crawled user's top songs via user.getTopTracks and stores them, normalized, in the users database.
// Top songs: two requests per user, period=overall and period=12month, first 50 songs each, no pagination.
// Loved songs: user.getLovedTracks per user, every page.
// Both share the songs and artists tables, so a song on several lists is stored once, and the
// user_merged_songs view merges them per user.
// Usage: node scripts/fetch-top-tracks.mjs --db data/users.db.age [--max-users 5000] [--minutes 40]
//                                          [--part-mb 1900] [--concurrency 6] [--max-per-second 4]
//
// Requests run in parallel, sharing one speed limit that slows down if Last.fm reports rate limiting.
//
// Order: LAST_FM_USERNAME first (similarity is measured against that user), then most total listens (from
// fetch-user-info.mjs), then most friends, then random. Users known to have no listens go last.
// Each user is pulled once, ever: songs_fetched_at and loved_fetched_at are tracked separately, and whichever
// is already set is never requested again.
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
import { createClient } from "./lastfm-client.mjs";
import { startProgress } from "./progress.mjs";
import { encryptedDbExists, readEncryptedDb, writeEncryptedDb, DEFAULT_PART_MB } from "./db-store.mjs";
import { addProfileColumns, FRIEND_COUNTS, FRIENDS } from "./user-activity.mjs";

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
const LOVED_PAGE_SIZE = Number(args["loved-page-size"] ?? 1000);
const CONCURRENCY = Number(args.concurrency ?? 6); // enough to reach the speed limit despite slow loved-track pages
const MAX_CONSECUTIVE_FAILURES = 20;

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

const now = () => new Date().toISOString();

// ---- Last.fm ---------------------------------------------------------------------------------

const client = createClient({ apiKey, userAgent, maxPerSecond: Number(args["max-per-second"] ?? 4) });
const { apiGet } = client;

const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

async function getTopSongs(user, period) {
  const r = await apiGet({ method: "user.getTopTracks", user, period, limit: String(LIMIT), page: "1" }, "toptracks");
  if (r.error) return r;
  return {
    songs: asArray(r.track).filter((x) => x.name && x.artist?.name).map((x) => ({
      name: x.name,
      artist: x.artist.name,
      mbid: x.mbid || null,
      duration: Number(x.duration) || null,
      plays: Number(x.playcount) || 0,
      rank: Number(x["@attr"]?.rank) || 0,
    })),
    total: Number(r["@attr"]?.total) || 0,
  };
}

// Reads every page. Nothing is returned unless all pages succeed, so a user is never saved half-read.
async function getLovedSongs(user) {
  const songs = [];
  let total = 0, totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const r = await apiGet({ method: "user.getLovedTracks", user, limit: String(LOVED_PAGE_SIZE), page: String(page) }, "lovedtracks");
    if (r.error) return r;
    totalPages = Number(r["@attr"]?.totalPages) || 1;
    total = Number(r["@attr"]?.total) || 0;
    for (const x of asArray(r.track)) {
      if (x.name && x.artist?.name) {
        songs.push({ name: x.name, artist: x.artist.name, mbid: x.mbid || null, lovedAt: Number(x.date?.uts) || null });
      }
    }
  }
  return { songs, total };
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

  CREATE TABLE IF NOT EXISTS user_loved_songs (
    user_id  INTEGER NOT NULL REFERENCES users (id),
    song_id  INTEGER NOT NULL REFERENCES songs (id),
    loved_at INTEGER,  -- unix seconds
    PRIMARY KEY (user_id, song_id)
  ) WITHOUT ROWID;

  -- Readable versions, computed on demand so they cost no storage.
  CREATE VIEW IF NOT EXISTS user_loved_songs_named AS
    SELECT u.name AS user, a.name AS artist, s.name AS song, l.loved_at
    FROM user_loved_songs l
    JOIN users u ON u.id = l.user_id
    JOIN songs s ON s.id = l.song_id
    JOIN artists a ON a.id = s.artist_id;

  -- Each user's top songs and loved songs merged, one row per user and song.
  CREATE VIEW IF NOT EXISTS user_merged_songs AS
    SELECT u.name AS user, a.name AS artist, s.name AS song,
           (SELECT min(t.rank) FROM user_songs t WHERE t.user_id = m.user_id AND t.period_id = 1 AND t.song_id = m.song_id) AS overall_rank,
           (SELECT max(t.playcount) FROM user_songs t WHERE t.user_id = m.user_id AND t.period_id = 1 AND t.song_id = m.song_id) AS overall_plays,
           (SELECT min(t.rank) FROM user_songs t WHERE t.user_id = m.user_id AND t.period_id = 2 AND t.song_id = m.song_id) AS last_12_months_rank,
           (SELECT max(t.playcount) FROM user_songs t WHERE t.user_id = m.user_id AND t.period_id = 2 AND t.song_id = m.song_id) AS last_12_months_plays,
           l.song_id IS NOT NULL AS loved,
           l.loved_at
    FROM (SELECT user_id, song_id FROM user_songs UNION SELECT user_id, song_id FROM user_loved_songs) m
    JOIN users u ON u.id = m.user_id
    JOIN songs s ON s.id = m.song_id
    JOIN artists a ON a.id = s.artist_id
    LEFT JOIN user_loved_songs l ON l.user_id = m.user_id AND l.song_id = m.song_id;

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
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  for (const [name, type] of [["loved_fetched_at", "TEXT"], ["loved_error", "TEXT"], ["loved_total", "INTEGER"]]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  if (!db.prepare("PRAGMA table_info(song_runs)").all().some((c) => c.name === "users_loved")) {
    db.exec("ALTER TABLE song_runs ADD COLUMN users_loved INTEGER");
  }
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
  markLoved: db.prepare("UPDATE users SET loved_fetched_at = ?, loved_error = ?, loved_total = ? WHERE id = ?"),
  insertLoved: db.prepare("INSERT INTO user_loved_songs (user_id, song_id, loved_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
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

function saveLoved(userId, { songs, total }) {
  tx(() => {
    for (const s of songs) {
      const artistId = q.upsertArtist.get(s.artist).id;
      const songId = q.upsertSong.get(artistId, s.name, s.mbid, null).id;
      q.insertLoved.run(userId, songId, s.lovedAt);
    }
    q.markLoved.run(now(), null, total, userId);
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

addProfileColumns(db);
const queue = db.prepare(`
  WITH ${FRIEND_COUNTS}
  SELECT u.id, u.name, u.songs_fetched_at, u.loved_fetched_at
  FROM users u LEFT JOIN friend_counts f ON f.name = u.name COLLATE NOCASE
  WHERE u.songs_fetched_at IS NULL OR u.loved_fetched_at IS NULL
  ORDER BY u.name = ? COLLATE NOCASE DESC,
           u.profile_fetched_at IS NOT NULL AND COALESCE(u.total_plays, 0) = 0,
           u.total_plays DESC,
           ${FRIENDS} DESC,
           random()
  LIMIT ?
`).all(me ?? "", maxUsers);
console.log(`Queued ${queue.length} users`);

let fetched = 0, lovedFetched = 0, errored = 0, consecutiveFailures = 0, stopReason = "queue finished";

let stopped = false;
function stop(reason) {
  if (!stopped) stopReason = reason;
  stopped = true;
}

// Stops the whole run on an API key problem or a run of failures.
function noteFailure(r) {
  if (r.kind === "fatal") stop(`Last.fm stopped us: ${r.error}`);
  else if (r.kind === "transient" && ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    stop(`repeated failures (${r.error})`);
  }
}

async function processUser(user) {
  if (!user.songs_fetched_at) {
    const [overall, recent] = await Promise.all(PERIODS.map((p) => getTopSongs(user.name, p.name)));
    const failure = overall.error ? overall : recent.error ? recent : null;
    if (failure) {
      noteFailure(failure);
      if (failure.kind !== "permanent") return; // left unfetched, so a later run retries this user
      q.markFetched.run(now(), failure.error, user.id);
      errored++;
      consecutiveFailures = 0;
    } else {
      saveUser(user.id, { [PERIODS[0].id]: overall, [PERIODS[1].id]: recent });
      fetched++;
      consecutiveFailures = 0;
    }
  }

  if (stopped) return;
  if (!user.loved_fetched_at) {
    const r = await getLovedSongs(user.name);
    if (r.error) {
      noteFailure(r);
      if (r.kind !== "permanent") return;
      q.markLoved.run(now(), r.error, null, user.id);
      errored++;
      consecutiveFailures = 0;
    } else {
      saveLoved(user.id, r);
      lovedFetched++;
      consecutiveFailures = 0;
    }
  }

  processed++;
}

// Saves are synchronous, so parallel workers can't interleave a database transaction.
let processed = 0, nextUser = 0;
const fetchStart = Date.now();
const progress = startProgress({
  label: "users",
  total: queue.length,
  deadline,
  everySeconds: Number(args["log-seconds"] ?? 30),
  getCounts: () => ({
    done: processed,
    errors: errored,
    requests: client.stats.requests,
    rateLimited: client.stats.rateLimited,
    extra: `${fetched} top songs, ${lovedFetched} loved, db ${(dbBytes() / 1048576).toFixed(1)} MB`,
  }),
});
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (!stopped && nextUser < queue.length) {
    if (Date.now() >= deadline) { stop("time limit"); break; }
    await processUser(queue[nextUser++]);
  }
}));
progress.stop();
const perSecond = client.stats.requests / Math.max(1, (Date.now() - fetchStart) / 1000);

if (fetched > 0) {
  console.log("Updating similarity scores...");
  updateSimilarity();
}

db.prepare(
  "UPDATE song_runs SET finished_at = ?, users_fetched = ?, users_loved = ?, users_errored = ?, requests = ?, stop_reason = ? WHERE id = ?"
).run(now(), fetched, lovedFetched, errored, client.stats.requests, stopReason, runId);

const count = (sql) => db.prepare(sql).get().n;
const remaining = count("SELECT count(*) AS n FROM users WHERE songs_fetched_at IS NULL");
const remainingLoved = count("SELECT count(*) AS n FROM users WHERE loved_fetched_at IS NULL");
const totalLoved = count("SELECT count(*) AS n FROM user_loved_songs");
const totalSongs = count("SELECT count(*) AS n FROM songs");
const totalArtists = count("SELECT count(*) AS n FROM artists");
const totalRows = count("SELECT count(*) AS n FROM user_songs");
console.log("Compacting and saving the database...");
db.exec("VACUUM");
const finalBytes = dbBytes();
db.close();

const files = encrypted ? await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), partMb) : 1;
fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `Top songs: ${fetched} users (${remaining} left). Loved songs: ${lovedFetched} users (${remainingLoved} left). ` +
  `${errored} errored, ${client.stats.requests} requests (${perSecond.toFixed(1)}/s, ${client.stats.rateLimited} rate limited). Database: ${totalSongs} songs, ${totalArtists} artists, ` +
  `${totalRows} top-song rows, ${totalLoved} loved rows, ` +
  `${(finalBytes / 1048576).toFixed(1)} MB in ${files} file(s). Stopped: ${stopReason}`
);
if (!/queue finished|time limit/.test(stopReason)) console.log(`::warning::Stopped early: ${stopReason}`);
