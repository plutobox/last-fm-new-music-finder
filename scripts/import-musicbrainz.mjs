// Fills songs.release_year, songs.youtube_id and songs.spotify_id from a MusicBrainz database dump, with no API calls.
// Usage: node scripts/import-musicbrainz.mjs --dump <folder of extracted mbdump tables> --db db/users.db.age
// Tables needed: artist, artist_credit_name, recording, track, medium, release_country, release_unknown_country,
// l_recording_url, l_release_url, url.
//
// A song is linked to MusicBrainz recordings two ways:
// - its Last.fm MBID, which is usually a MusicBrainz track ID and sometimes a recording ID
// - the same title by the same artist, using the artist's MBID where we have it and the exact name otherwise
// Its year is the earliest release of any linked recording, and its video and Spotify track are the
// lowest-numbered links of each kind. Spotify album links are only counted: they don't identify the exact song.
// It only fills fields that are empty: a value already saved is never changed or cleared, even if a newer dump differs.
// Rerunning is safe: it's offline.
//
// --check reports coverage and sample songs without saving anything.
//
// The tables have no header rows, so columns are by position. They're the trimmed files written by
// mb-keep-columns.sh, which lists each table's columns.
// A ".age" --db needs LAST_FM_AGE_IDENTITY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb, writeEncryptedDb, DEFAULT_PART_MB } from "./db-store.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1]]);
    return acc;
  }, [])
);

const dumpDir = args.dump;
if (!dumpDir) throw new Error("--dump is required");
const dbPath = args.db ?? "data/users.db";
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const encrypted = dbPath.endsWith(".age");
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

const THIS_YEAR = new Date().getUTCFullYear();
const YOUTUBE_ID = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})(?![\w-])/;
const SPOTIFY_TRACK_ID = /open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})(?![A-Za-z0-9])/;
const SPOTIFY_ALBUM = /open\.spotify\.com\/(?:intl-[a-z]+\/)?album\//;
const started = Date.now();
const log = (message) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`);

// Case, accents and punctuation don't count: "Do I Wanna Know?" matches "do i wanna know".
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Calls onRow(columns) for each row of a dump table. \N means empty.
async function eachRow(table, onRow) {
  const file = path.join(dumpDir, table);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing`);
  let rows = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of lines) {
    onRow(line.split("\t"));
    rows++;
  }
  log(`read ${table}: ${rows} rows`);
}

const addTo = (map, key, value) => {
  const existing = map.get(key);
  if (existing) existing.add(value); else map.set(key, new Set([value]));
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-mb-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));
const db = new DatabaseSync(localDb);
db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;");

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
for (const name of ["release_year INTEGER", "youtube_id TEXT", "spotify_id TEXT"]) {
  if (!columnsOf("songs").includes(name.split(" ")[0])) db.exec(`ALTER TABLE songs ADD COLUMN ${name}`);
}

// ---- Our songs and artists -------------------------------------------------------------------

const artistMbidColumn = columnsOf("artists").includes("mbid") ? "mbid" : "NULL AS mbid";
const ourArtists = db.prepare(`SELECT id, name, ${artistMbidColumn} FROM artists`).all();
const songs = db.prepare("SELECT id, artist_id, name, mbid FROM songs").all();
log(`our data: ${songs.length} songs, ${ourArtists.length} artists`);

const songsByMbid = new Map(); // Last.fm song MBID -> our song ids
const songsByTitle = new Map(); // normalized title -> songs
for (const s of songs) {
  if (s.mbid) addTo(songsByMbid, s.mbid, s.id);
  const key = norm(s.name);
  if (!key) continue;
  const list = songsByTitle.get(key);
  if (list) list.push(s); else songsByTitle.set(key, [s]);
}
const artistsByMbid = new Map(ourArtists.filter((a) => a.mbid).map((a) => [a.mbid, a.id]));
const artistsByName = new Map(); // normalized name -> our artist ids, only for artists with no MBID
for (const a of ourArtists) if (!a.mbid && norm(a.name)) addTo(artistsByName, norm(a.name), a.id);

// ---- MusicBrainz artists and credits ---------------------------------------------------------

const ourArtistsByMbArtist = new Map(); // MusicBrainz artist id -> our artist ids
await eachRow("artist", (r) => {
  const byId = artistsByMbid.get(r[1]);
  if (byId) addTo(ourArtistsByMbArtist, r[0], byId);
  const byName = artistsByName.get(norm(r[2]));
  if (byName) for (const id of byName) addTo(ourArtistsByMbArtist, r[0], id);
});
log(`matched MusicBrainz artists: ${ourArtistsByMbArtist.size}`);

const ourArtistsByCredit = new Map(); // artist credit id -> our artist ids
await eachRow("artist_credit_name", (r) => {
  const ours = ourArtistsByMbArtist.get(r[1]);
  if (ours) for (const id of ours) addTo(ourArtistsByCredit, r[0], id);
});
log(`matched artist credits: ${ourArtistsByCredit.size}`);

// ---- Link songs to recordings ----------------------------------------------------------------

const songsByRecording = new Map(); // MusicBrainz recording id -> our song ids
let byRecordingId = 0, byTrackId = 0, byTitle = 0;
await eachRow("recording", (r) => {
  const direct = songsByMbid.get(r[1]);
  if (direct) { for (const id of direct) addTo(songsByRecording, r[0], id); byRecordingId++; }
  const credit = ourArtistsByCredit.get(r[3]);
  if (!credit) return;
  const candidates = songsByTitle.get(norm(r[2]));
  if (!candidates) return;
  for (const s of candidates) {
    if (credit.has(s.artist_id)) { addTo(songsByRecording, r[0], s.id); byTitle++; }
  }
});
await eachRow("track", (r) => {
  const direct = songsByMbid.get(r[1]);
  if (direct) { for (const id of direct) addTo(songsByRecording, r[2], id); byTrackId++; }
});
log(`links: ${byRecordingId} by recording ID, ${byTrackId} by track ID, ${byTitle} by title and artist`);

// ---- Earliest year per recording --------------------------------------------------------------

const recordingsByMedium = new Map();
await eachRow("track", (r) => { if (songsByRecording.has(r[2])) addTo(recordingsByMedium, r[3], r[2]); });
const recordingsByRelease = new Map();
await eachRow("medium", (r) => {
  const recs = recordingsByMedium.get(r[0]);
  if (recs) for (const id of recs) addTo(recordingsByRelease, r[1], id);
});
recordingsByMedium.clear();

const yearBySong = new Map();
const noteYear = (release, yearText) => {
  const year = Number(yearText);
  if (!(year >= 1860 && year <= THIS_YEAR + 1)) return; // missing, or a data-entry mistake
  for (const rec of recordingsByRelease.get(release) ?? []) {
    for (const song of songsByRecording.get(rec)) {
      if (!yearBySong.has(song) || year < yearBySong.get(song)) yearBySong.set(song, year);
    }
  }
};
await eachRow("release_country", (r) => noteYear(r[0], r[1]));
await eachRow("release_unknown_country", (r) => noteYear(r[0], r[1]));

// ---- YouTube and Spotify links ----------------------------------------------------------------

const recordingsByUrl = new Map(); // url id -> [{ linkId, recording }]
await eachRow("l_recording_url", (r) => {
  if (!songsByRecording.has(r[1])) return;
  const list = recordingsByUrl.get(r[2]);
  const entry = { linkId: Number(r[0]), recording: r[1] };
  if (list) list.push(entry); else recordingsByUrl.set(r[2], [entry]);
});
const releasesByUrl = new Map(); // url id -> releases of our songs
await eachRow("l_release_url", (r) => { if (recordingsByRelease.has(r[0])) addTo(releasesByUrl, r[1], r[0]); });

const videoBySong = new Map(); // song id -> { linkId, id }
const spotifyBySong = new Map(); // song id -> { linkId, id }
const spotifyAlbumSongs = new Set();
const keepLowest = (bySong, links, id) => {
  for (const { linkId, recording } of links) {
    for (const song of songsByRecording.get(recording)) {
      const best = bySong.get(song);
      if (!best || linkId < best.linkId) bySong.set(song, { linkId, id });
    }
  }
};
await eachRow("url", (r) => {
  const links = recordingsByUrl.get(r[0]);
  if (links) {
    const videoId = r[1].match(YOUTUBE_ID)?.[1];
    if (videoId) keepLowest(videoBySong, links, videoId);
    const spotifyId = r[1].match(SPOTIFY_TRACK_ID)?.[1];
    if (spotifyId) keepLowest(spotifyBySong, links, spotifyId);
  }
  const releases = releasesByUrl.get(r[0]);
  if (releases && SPOTIFY_ALBUM.test(r[1])) {
    for (const release of releases) {
      for (const rec of recordingsByRelease.get(release)) {
        for (const song of songsByRecording.get(rec)) spotifyAlbumSongs.add(song);
      }
    }
  }
});

// ---- Save -------------------------------------------------------------------------------------

const linked = new Set(); for (const ids of songsByRecording.values()) for (const id of ids) linked.add(id);

// Coverage by popularity, as counts only: Actions logs on a public repo are public.
const listeners = new Map(db.prepare(`
  SELECT song_id, count(*) AS n
  FROM (SELECT user_id, song_id FROM user_songs UNION SELECT user_id, song_id FROM user_loved_songs)
  GROUP BY song_id
`).all().map((r) => [r.song_id, r.n]));
const spotifyAlbumOnly = new Set([...spotifyAlbumSongs].filter((id) => !spotifyBySong.has(id)));
const byPopularity = [...songs].sort((a, b) => (listeners.get(b.id) ?? 0) - (listeners.get(a.id) ?? 0));
const report = (label, list) => {
  const part = (m) => { const n = list.filter((s) => m.has(s.id)).length; return `${n} (${Math.round((n * 100) / Math.max(1, list.length))}%)`; };
  log(`${label}, ${list.length} songs: linked ${part(linked)}, year ${part(yearBySong)}, YouTube ${part(videoBySong)}, Spotify track ${part(spotifyBySong)}, Spotify album only ${part(spotifyAlbumOnly)}`);
};
report("Top 1,000", byPopularity.slice(0, 1000));
report("Top 20,000", byPopularity.slice(0, 20000));
report("2+ listeners", songs.filter((s) => (listeners.get(s.id) ?? 0) >= 2));
report("All songs", songs);
const knownYears = [["Madonna", "Hung Up", 2005], ["Radiohead", "Creep", 1992], ["Radiohead", "Karma Police", 1997], ["Oasis", "Wonderwall", 1995], ["Lana Del Rey", "Born to Die", 2011], ["Arctic Monkeys", "Do I Wanna Know?", 2013]];
const artistNames = new Map(ourArtists.map((a) => [a.id, a.name]));
for (const [artist, title, known] of knownYears) {
  const s = songs.find((x) => artistNames.get(x.artist_id) === artist && x.name.toLowerCase() === title.toLowerCase());
  log(`Known song: ${artist} - ${title}: released ${known}, found ${s ? yearBySong.get(s.id) ?? "no year" : "not in database"}${s && videoBySong.has(s.id) ? ", has video" : ""}${s && spotifyBySong.has(s.id) ? ", has Spotify track" : ""}`);
}

if ("check" in args) {
  log("Check only, so nothing was saved");
} else {
  const save = db.prepare(`
    UPDATE songs SET
      release_year = COALESCE(release_year, ?),
      youtube_id = COALESCE(youtube_id, ?),
      spotify_id = COALESCE(spotify_id, ?)
    WHERE id = ?
  `);
  const counts = db.prepare("SELECT count(release_year) AS years, count(youtube_id) AS videos, count(spotify_id) AS spotify FROM songs");
  const before = counts.get();
  db.exec("BEGIN");
  for (const s of songs) save.run(yearBySong.get(s.id) ?? null, videoBySong.get(s.id)?.id ?? null, spotifyBySong.get(s.id)?.id ?? null, s.id);
  db.exec("COMMIT");
  const after = counts.get();
  log(`Filled empty fields: ${after.years - before.years} years, ${after.videos - before.videos} YouTube IDs, ${after.spotify - before.spotify} Spotify IDs`);
  log("Saving the database...");
  db.exec("VACUUM");
  db.close();
  if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), Number(args["part-mb"] ?? DEFAULT_PART_MB));
}
fs.rmSync(workDir, { recursive: true, force: true });
