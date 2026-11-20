// Builds the public, unencrypted data: one flat table of songs with their genres and aggregate counts, split into
// numbered files in one folder, plus a manifest.json that lists them. The website loads the files and joins them.
// The same table is also written as Parquet files, one band of listener counts each (songs-parquet.mjs), which the
// manifest lists under "parquet", for a site that queries them with DuckDB instead of loading everything.
// Only reads the database, which it opens read-only. No usernames, profiles or per-user data go in.
// Usage: node scripts/export-songs.mjs --db db/users.db.age --out pages/data/songs [--part-mb 10] [--no-parquet]
//
// Songs need at least MIN_LISTENERS listeners, so a row can't simply be one person's listening. An unchanged table
// leaves the files untouched, so the workflow has nothing to commit.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb } from "./db-store.mjs";
import { PARQUET_FORMAT, writeSongParquet } from "./songs-parquet.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const MIN_LISTENERS = 2;
const MIN_TAG_COUNT = 20; // ignore tags Last.fm itself weights weakly for an artist
const COLUMNS = ["artist", "song", "genres", "listeners", "plays", "loved_by", "year", "youtube_id", "spotify_id", "id"];

// Only these become genres, so tags like "seen live" or an artist's own name never reach the file.
// Keys are Last.fm tags in lowercase; values are the genre shown.
const GENRES = Object.fromEntries(Object.entries({
  "pop": ["pop"], "dance-pop": ["dance pop", "dance-pop"], "electropop": ["electropop", "electro pop"],
  "synthpop": ["synthpop", "synth pop", "synth-pop"], "indie pop": ["indie pop"], "hyperpop": ["hyperpop"],
  "k-pop": ["k-pop", "kpop", "k pop"], "j-pop": ["j-pop", "jpop", "j pop"],
  "rock": ["rock"], "alternative rock": ["alternative rock"], "indie rock": ["indie rock"], "classic rock": ["classic rock"],
  "hard rock": ["hard rock"], "punk": ["punk", "punk rock"], "post-punk": ["post-punk", "post punk"], "emo": ["emo"],
  "shoegaze": ["shoegaze"], "grunge": ["grunge"], "progressive rock": ["progressive rock", "prog rock"],
  "psychedelic": ["psychedelic", "psychedelic rock"], "alternative": ["alternative"], "indie": ["indie"],
  "metal": ["metal", "heavy metal"], "death metal": ["death metal"], "black metal": ["black metal"],
  "metalcore": ["metalcore"], "hardcore": ["hardcore"],
  "hip-hop": ["hip-hop", "hip hop", "hiphop"], "rap": ["rap"], "trap": ["trap"], "r&b": ["r&b", "rnb", "r and b"], "soul": ["soul"],
  "funk": ["funk"], "disco": ["disco"], "jazz": ["jazz"], "blues": ["blues"],
  "electronic": ["electronic", "electronica"], "dance": ["dance"], "house": ["house"], "techno": ["techno"], "trance": ["trance"],
  "drum and bass": ["drum and bass", "dnb", "drum n bass"], "dubstep": ["dubstep"], "ambient": ["ambient"],
  "idm": ["idm"], "edm": ["edm"], "lo-fi": ["lo-fi", "lofi"], "experimental": ["experimental"],
  "folk": ["folk"], "indie folk": ["indie folk"], "country": ["country"], "singer-songwriter": ["singer-songwriter", "singer songwriter"],
  "acoustic": ["acoustic"], "classical": ["classical"], "soundtrack": ["soundtrack"],
  "reggae": ["reggae"], "reggaeton": ["reggaeton"], "latin": ["latin"], "afrobeats": ["afrobeats", "afrobeat"],
}).flatMap(([genre, tags]) => tags.map((t) => [t, genre])));

const dbPath = args.db ?? "data/users.db";
const out = args.out ?? "data/songs";
const partBytes = Number(args["part-mb"] ?? 10) * 1024 * 1024;
const encrypted = dbPath.endsWith(".age");
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-export-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) await readEncryptedDb(dbPath, ageIdentity, localDb);
const db = new DatabaseSync(localDb, { readOnly: true });

console.log("Reading the database...");
// Adds rows of { id, name } to a map of id -> genres, in the order given and without repeats.
function collectGenres(rows) {
  const out = new Map();
  for (const r of rows) {
    const genre = GENRES[r.name.toLowerCase()];
    if (!genre) continue;
    const list = out.get(r.id) ?? [];
    if (!list.includes(genre)) list.push(genre);
    out.set(r.id, list);
  }
  return out;
}

const artistGenres = collectGenres(db.prepare(`
  SELECT at.artist_id AS id, t.name FROM artist_tags at JOIN tags t ON t.id = at.tag_id
  WHERE at.count >= ? ORDER BY at.artist_id, at.count DESC, t.name
`).iterate(MIN_TAG_COUNT));
const songGenres = collectGenres(db.prepare(`
  SELECT st.song_id AS id, t.name FROM song_tags st JOIN tags t ON t.id = st.tag_id
  ORDER BY st.song_id, st.position
`).iterate());

// These come from import-musicbrainz.mjs, which may not have run on this database yet.
const songColumns = db.prepare("PRAGMA table_info(songs)").all().map((c) => c.name);
const optionalSongColumn = (name) => (songColumns.includes(name) ? `s.${name}` : "NULL");

const candidates = db.prepare(`
  WITH listeners AS (
    SELECT song_id, count(*) AS n
    FROM (SELECT user_id, song_id FROM user_songs UNION SELECT user_id, song_id FROM user_loved_songs)
    GROUP BY song_id
  ),
  -- A user can have a song in both periods; the overall count already includes the 12-month plays, so take the higher.
  plays AS (
    SELECT song_id, sum(p) AS n
    FROM (SELECT user_id, song_id, max(playcount) AS p FROM user_songs GROUP BY user_id, song_id)
    GROUP BY song_id
  ),
  loved AS (SELECT song_id, count(*) AS n FROM user_loved_songs GROUP BY song_id)
  SELECT s.id AS song_id, s.artist_id, a.name AS artist, s.name AS song, ${optionalSongColumn("release_year")} AS year,
         COALESCE(${optionalSongColumn("youtube_search_id")}, ${optionalSongColumn("youtube_id")}) AS youtube_id, ${optionalSongColumn("spotify_id")} AS spotify_id, l.n AS listeners,
         coalesce(p.n, 0) AS plays, coalesce(h.n, 0) AS loved_by
  FROM listeners l
  JOIN songs s ON s.id = l.song_id
  JOIN artists a ON a.id = s.artist_id
  LEFT JOIN plays p ON p.song_id = l.song_id
  LEFT JOIN loved h ON h.song_id = l.song_id
  WHERE l.n >= ?
  ORDER BY l.n DESC, plays DESC, a.name, s.name
`).all(MIN_LISTENERS);
db.close();
if (encrypted) fs.rmSync(localDb);

const rows = [];
const lines = [];
let untagged = 0, fromSong = 0, fromArtist = 0;
for (const c of candidates) {
  // A song's own tags win. Without any usable ones, it takes its artist's.
  const own = songGenres.get(c.song_id);
  const genres = own ?? artistGenres.get(c.artist_id);
  if (!genres) { untagged++; continue; }
  const row = [c.artist, c.song, genres, c.listeners, c.plays, c.loved_by, c.year, c.youtube_id, c.spotify_id, c.song_id];
  rows.push(row);
  lines.push(JSON.stringify(row));
  if (own) fromSong++; else fromArtist++;
}

const hash = crypto.createHash("sha256");
for (const line of lines) hash.update(line).update("\n");
const version = hash.digest("hex").slice(0, 16);

const manifestPath = path.join(out, "manifest.json");
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const changed = previous?.version !== version;
// --no-parquet skips them, for a copy only scripts read. An unchanged table still gets Parquet files if it has none
// yet, or only ones in an older layout.
const withParquet = !("no-parquet" in args);
const writeParquet = withParquet && (changed || previous?.parquet?.format !== PARQUET_FORMAT || !previous?.genres);
let parts = previous?.parts;
if (changed) {
  parts = [];
  const writePart = (partLines) => {
    const name = `part-${String(parts.length).padStart(3, "0")}.json`;
    const text = `{"rows":[\n${partLines.join(",\n")}\n]}\n`;
    fs.writeFileSync(path.join(out, name), text);
    parts.push({ name, songs: partLines.length, bytes: Buffer.byteLength(text) });
  };
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (/^part-\d+\.json$/.test(f)) fs.rmSync(path.join(out, f));
  let current = [], size = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 2;
    if (current.length && size + lineBytes > partBytes) { writePart(current); current = []; size = 0; }
    current.push(line);
    size += lineBytes;
  }
  if (current.length) writePart(current);
}
const parquet = writeParquet
  ? { format: PARQUET_FORMAT, files: await writeSongParquet(rows, COLUMNS, out, workDir) }
  : previous?.parquet;
fs.rmSync(workDir, { recursive: true, force: true });
if (changed || writeParquet) {
  // Every genre with its song count, biggest first, so the site can list them without reading every song.
  const genreCounts = new Map();
  for (const row of rows) for (const g of row[2]) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
  const genres = [...genreCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Written last, so a stopped run can't leave a manifest pointing at files that aren't there yet.
  const builtAt = changed ? new Date().toISOString() : previous.built_at;
  const manifest = { built_at: builtAt, version, columns: COLUMNS, count: lines.length, genres, parts, parquet };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const megabytes = (files) => (files.reduce((sum, p) => sum + p.bytes, 0) / 1048576).toFixed(2);
console.log(
  `${changed ? "Wrote" : "No change to"} ${out}: ${manifest.count} songs in ${manifest.parts.length} JSON file(s), ${megabytes(manifest.parts)} MB` +
  (manifest.parquet
    ? `${writeParquet ? ", wrote" : ", kept"} ${manifest.parquet.files.length} Parquet file(s), ${megabytes(manifest.parquet.files)} MB. `
    : ", no Parquet files. ") +
  `Genres from the song ${fromSong}, from the artist ${fromArtist}. Left out: ${untagged} with no known genre yet.`
);
