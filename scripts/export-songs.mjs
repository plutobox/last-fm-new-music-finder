// Builds the one public, unencrypted file: a flat table of songs with their genres and aggregate counts.
// Only reads the database, which it opens read-only. No usernames, profiles or per-user data go in.
// Usage: node scripts/export-songs.mjs --db db/users.db.age --out pages/data/songs.json [--max-mb 50]
//
// Songs need at least MIN_LISTENERS listeners, so a row can't simply be one person's listening. If the table
// passes --max-mb, the least popular rows are dropped. An unchanged table leaves the file untouched, so the
// workflow has nothing to commit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb } from "./db-store.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const MIN_LISTENERS = 2;
const MIN_TAG_COUNT = 20; // ignore tags Last.fm itself weights weakly for an artist
const COLUMNS = ["artist", "song", "genres", "listeners", "plays", "loved_by", "year", "youtube_id"];

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
const out = args.out ?? "data/songs.json";
const maxBytes = Number(args["max-mb"] ?? 50) * 1024 * 1024;
const encrypted = dbPath.endsWith(".age");
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-export-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));
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
         ${optionalSongColumn("youtube_id")} AS youtube_id, l.n AS listeners,
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
fs.rmSync(workDir, { recursive: true, force: true });

const wrapperBytes = 200;
const rows = [];
let bytes = wrapperBytes, untagged = 0, droppedForSize = 0, fromSong = 0, fromArtist = 0;
for (const c of candidates) {
  // A song's own tags win. Without any usable ones, it takes its artist's.
  const own = songGenres.get(c.song_id);
  const genres = own ?? artistGenres.get(c.artist_id);
  if (!genres) { untagged++; continue; }
  const row = [c.artist, c.song, genres, c.listeners, c.plays, c.loved_by, c.year, c.youtube_id];
  const size = Buffer.byteLength(JSON.stringify(row)) + 2;
  if (bytes + size > maxBytes) { droppedForSize++; continue; }
  bytes += size;
  rows.push(row);
  if (own) fromSong++; else fromArtist++;
}

const previous = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
const changed = JSON.stringify(previous?.rows) !== JSON.stringify(rows);
if (changed) {
  const lines = rows.map((r) => JSON.stringify(r)).join(",\n");
  const text = `{"built_at":${JSON.stringify(new Date().toISOString())},"columns":${JSON.stringify(COLUMNS)},"rows":[\n${lines}\n]}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${out} would pass the size limit`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
}

console.log(
  `${changed ? "Wrote" : "No change to"} ${out}: ${rows.length} songs, ${(fs.statSync(out).size / 1048576).toFixed(2)} MB. ` +
  `Genres from the song ${fromSong}, from the artist ${fromArtist}. ` +
  `Left out: ${untagged} with no known genre yet, ${droppedForSize} over the size limit.`
);
