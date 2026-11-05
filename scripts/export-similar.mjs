// For each public song, finds the songs its listeners also listen to or love, for the site's "Like this song?" button.
// Only reads the database. The output holds song IDs and counts of shared listeners: no usernames or per-user data, and
// a match needs at least --min-shared listeners in common, so it can't simply be one person's list.
// Usage: node scripts/export-similar.mjs --db db/users.db.age --songs-dir public-songs --out similar-out
//          [--songs "Mallrat - Groceries,Karma Police"] [--minutes 300] [--min-listeners 3] [--top 20]
//          [--min-shared 3] [--max-per-artist 3] [--max-user-songs 10000] [--shards 512]
//
// --songs-dir is a folder written by export-songs.mjs: only songs in it are matched or shown. --songs (or the SONGS env
// var) limits the build to those songs, each "Artist - Song" or a title for every song with that title, and ignores
// --min-listeners. Otherwise it goes through songs with at least --min-listeners listeners, most listeners first, until
// done or --minutes runs out. merge-similar.mjs publishes the output, keeping earlier results for any song not rebuilt.
//
// Users with more than --max-user-songs songs are left out of the math: the work grows with the square of each list.
// A ".age" --db needs LAST_FM_AGE_IDENTITY. Logs print counts only, and the song names typed into --songs.
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

const dbPath = args.db ?? "data/users.db";
const songsDir = args["songs-dir"];
const outDir = args.out;
if (!songsDir || !outDir) throw new Error("--songs-dir and --out are required");
const SONGS = (args.songs ?? process.env.SONGS ?? "").trim();
const MINUTES = Number(args.minutes ?? 300);
const MIN_LISTENERS = Number(args["min-listeners"] ?? 3); // a match needs 3 in common, so fewer could never have one
const TOP = Number(args.top ?? 20);
const MIN_SHARED = Number(args["min-shared"] ?? 3);
const MAX_PER_ARTIST = Number(args["max-per-artist"] ?? 3);
const MAX_USER_SONGS = Number(args["max-user-songs"] ?? 10000);
const SHARDS = Number(args.shards ?? 512);
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const encrypted = dbPath.endsWith(".age");
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

const started = Date.now();
const log = (message) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`);

// ---- The public songs -------------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(songsDir, "manifest.json"), "utf8"));
const column = (name) => {
  const i = manifest.columns.indexOf(name);
  if (i < 0) throw new Error(`${songsDir} has no "${name}" column`);
  return i;
};
const [idColumn, artistColumn, songColumn, listenersColumn] = ["id", "artist", "song", "listeners"].map(column);

const count = manifest.count;
const ids = new Int32Array(count);
const artists = new Int32Array(count);
const publicListeners = new Int32Array(count);
const artistNumbers = new Map();
const byName = new Map(); // lowercase title, or lowercase "artist - title" -> song positions
const addName = (name, i) => { const key = name.toLowerCase(); const list = byName.get(key); if (list) list.push(i); else byName.set(key, [i]); };
let total = 0, maxId = 0;
for (const part of manifest.parts) {
  for (const r of JSON.parse(fs.readFileSync(path.join(songsDir, part.name), "utf8")).rows) {
    const i = total++;
    ids[i] = r[idColumn];
    if (r[idColumn] > maxId) maxId = r[idColumn];
    publicListeners[i] = r[listenersColumn];
    const artist = r[artistColumn];
    if (!artistNumbers.has(artist)) artistNumbers.set(artist, artistNumbers.size);
    artists[i] = artistNumbers.get(artist);
    if (SONGS) { addName(r[songColumn], i); addName(`${artist} - ${r[songColumn]}`, i); }
  }
}
const positionOfId = new Int32Array(maxId + 1).fill(-1);
for (let i = 0; i < total; i++) positionOfId[ids[i]] = i;
log(`public songs: ${total}`);

// ---- Who listens to what ----------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-similar-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));
const db = new DatabaseSync(localDb, { readOnly: true });

let pairUsers = new Int32Array(1 << 22), pairSongs = new Int32Array(1 << 22), pairs = 0;
const userNumbers = new Map();
for (const r of db.prepare("SELECT user_id AS u, song_id AS s FROM user_songs UNION SELECT user_id, song_id FROM user_loved_songs").iterate()) {
  const song = r.s <= maxId ? positionOfId[r.s] : -1;
  if (song < 0) continue;
  if (pairs === pairUsers.length) {
    const biggerUsers = new Int32Array(pairs * 2), biggerSongs = new Int32Array(pairs * 2);
    biggerUsers.set(pairUsers);
    biggerSongs.set(pairSongs);
    pairUsers = biggerUsers;
    pairSongs = biggerSongs;
  }
  let user = userNumbers.get(r.u);
  if (user === undefined) { user = userNumbers.size; userNumbers.set(r.u, user); }
  pairUsers[pairs] = user;
  pairSongs[pairs++] = song;
}
db.close();
fs.rmSync(workDir, { recursive: true, force: true });

// Each user's songs and each song's users, as flat arrays for speed.
const userSize = new Int32Array(userNumbers.size);
for (let i = 0; i < pairs; i++) userSize[pairUsers[i]]++;
let leftOut = 0, kept = 0;
const songStart = new Int32Array(total + 1);
for (let i = 0; i < pairs; i++) {
  if (userSize[pairUsers[i]] <= MAX_USER_SONGS) { songStart[pairSongs[i] + 1]++; kept++; }
}
for (const n of userSize) if (n > MAX_USER_SONGS) leftOut++;
for (let i = 0; i < total; i++) songStart[i + 1] += songStart[i];
const userStart = new Int32Array(userNumbers.size + 1);
for (let u = 0; u < userSize.length; u++) userStart[u + 1] = userStart[u] + (userSize[u] <= MAX_USER_SONGS ? userSize[u] : 0);
const songUsers = new Int32Array(kept), userSongs = new Int32Array(kept);
const songFill = songStart.slice(), userFill = userStart.slice();
for (let i = 0; i < pairs; i++) {
  const u = pairUsers[i], s = pairSongs[i];
  if (userSize[u] > MAX_USER_SONGS) continue;
  songUsers[songFill[s]++] = u;
  userSongs[userFill[u]++] = s;
}
log(`pairs ${pairs}, used ${kept}; users ${userSize.length}, left out for very large lists ${leftOut}`);

// ---- Which songs to build ---------------------------------------------------------------------

// Splits on commas, except inside "double quotes", as a title can contain a comma.
function parseCsv(text) {
  const out = [];
  for (const m of text.matchAll(/\s*(?:"((?:[^"]|"")*)"|([^,]*))\s*(?:,|$)/g)) {
    const value = (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]).trim();
    if (value) out.push(value);
    if (m.index + m[0].length >= text.length) break;
  }
  return out;
}

let targets;
if (SONGS) {
  const chosen = new Set();
  for (const name of parseCsv(SONGS)) {
    const found = byName.get(name.toLowerCase()) ?? [];
    console.log(`"${name}": ${found.length} song(s)`);
    for (const i of found) chosen.add(i);
  }
  targets = [...chosen];
} else {
  // The public files are already most listeners first.
  targets = [];
  for (let i = 0; i < total; i++) if (publicListeners[i] >= MIN_LISTENERS) targets.push(i);
}
log(`building matches for ${targets.length} songs`);

// ---- Build ------------------------------------------------------------------------------------

const counts = new Int32Array(total);
const touched = new Int32Array(total);
const artistSeen = new Int32Array(artistNumbers.size);

// A large share of listeners in common scores high, and the second factor keeps a pair of very rare songs from topping
// the list on a couple of shared listeners by chance.
function matchesFor(target) {
  let n = 0;
  for (let i = songStart[target]; i < songStart[target + 1]; i++) {
    const u = songUsers[i];
    for (let j = userStart[u]; j < userStart[u + 1]; j++) {
      const s = userSongs[j];
      if (counts[s]++ === 0) touched[n++] = s;
    }
  }
  const a = songStart[target + 1] - songStart[target];
  const candidates = [];
  for (let i = 0; i < n; i++) {
    const s = touched[i], shared = counts[s];
    counts[s] = 0;
    if (s === target || shared < MIN_SHARED) continue;
    candidates.push({ s, shared, score: (shared / Math.sqrt(a * (songStart[s + 1] - songStart[s]))) * (shared / (shared + 3)) });
  }
  candidates.sort((x, y) => y.score - x.score || y.shared - x.shared || x.s - y.s);
  const out = [], seen = [];
  for (const c of candidates) {
    const artist = artists[c.s];
    if (artistSeen[artist] >= MAX_PER_ARTIST) continue;
    artistSeen[artist]++;
    seen.push(artist);
    out.push([ids[c.s], c.shared]);
    if (out.length === TOP) break;
  }
  for (const artist of seen) artistSeen[artist] = 0;
  return out;
}

const shards = Array.from({ length: SHARDS }, () => []);
const deadline = Date.now() + MINUTES * 60_000;
let built = 0, empty = 0, lastLog = Date.now(), stopReason = "all songs done";
for (const target of targets) {
  if (Date.now() >= deadline) { stopReason = "time limit"; break; }
  const matches = matchesFor(target);
  if (matches.length) shards[ids[target] % SHARDS].push(`${JSON.stringify(String(ids[target]))}:${JSON.stringify(matches)}`);
  else empty++;
  built++;
  if (Date.now() - lastLog >= 60_000) {
    lastLog = Date.now();
    log(`${built} of ${targets.length} songs, ${empty} with no matches`);
  }
}

// ---- Save -------------------------------------------------------------------------------------

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
let files = 0, bytes = 0;
shards.forEach((lines, i) => {
  if (!lines.length) return;
  const text = `{\n${lines.join(",\n")}\n}\n`;
  fs.writeFileSync(path.join(outDir, `${String(i).padStart(3, "0")}.json`), text);
  files++;
  bytes += Buffer.byteLength(text);
});
fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify({ built_at: new Date().toISOString(), shards: SHARDS }, null, 1)}\n`);
log(`Built ${built} of ${targets.length} songs (${empty} with no matches) in ${files} file(s), ${(bytes / 1048576).toFixed(1)} MB. Stopped: ${stopReason}`);
if (stopReason !== "all songs done") console.log(`::warning::Song matches stopped early: ${stopReason}`);
