// Finds YouTube videos for songs with no MusicBrainz link, using yt-dlp for metadata only: no video or audio is
// downloaded, and no cookies or sign-in are used. Songs with 2+ listeners, most-listened first, each searched once.
// Usage: node scripts/fetch-youtube-ids.mjs --db db/users.db.age --results youtube-results.jsonl [--minutes 45]
//                                           [--workers 4] [--batch 25] [--max-songs 20000] [--yt-dlp yt-dlp]
//
// It only reads the database, so it can run alongside the Last.fm job. Results go to the --results file, and
// apply-youtube-ids.mjs saves them once that job has finished. Each line holds a song's database ID and its video ID.
//
// YouTube Music's song search goes first. Every result is then checked with the YouTube Data API (videos.list, about
// 1 quota unit per 50 videos): it must be public, embeddable, and name the song and artist. Anything that fails gets
// one try with normal YouTube search, under the same check. A song with no good video stays empty: that's better
// than playing the wrong thing.
//
// Results end up in songs.youtube_search_id, separate from songs.youtube_id, which import-musicbrainz.mjs rewrites.
//
// Stops, keeping its progress, after 3 challenged batches in a row ("Sign in to confirm you're not a bot"). It doesn't
// try to get past those, and it only warns, so the rest of the workflow still runs. Songs in a failed or challenged
// search aren't marked, so a later run retries them.
//
// Needs YOUTUBE_API_KEY. A ".age" --db also needs LAST_FM_AGE_IDENTITY. Logs print counts only.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb } from "./db-store.mjs";
import { startProgress } from "./progress.mjs";

const run = promisify(execFile);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set");

const dbPath = args.db ?? "data/users.db";
const resultsFile = args.results;
if (!resultsFile) throw new Error("--results is required");
const deadline = Date.now() + Number(args.minutes ?? 45) * 60_000;
const WORKERS = Number(args.workers ?? 4);
const BATCH = Number(args.batch ?? 25);
const MAX_SONGS = Number(args["max-songs"] ?? 20000);
const YT_DLP = args["yt-dlp"] ?? "yt-dlp";
const MAX_CHALLENGES_IN_A_ROW = 3;
const CHALLENGE = /sign in to confirm|not a bot|http error 429|too many requests/i;
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const encrypted = dbPath.endsWith(".age");
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --db is a .age file");
if (!(encrypted ? encryptedDbExists(dbPath) : fs.existsSync(dbPath))) throw new Error(`${dbPath} does not exist`);

// ---- Matching --------------------------------------------------------------------------------

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// "212 (feat. Lazy Jay)" and "Running Up That Hill (A Deal with God)" should match without the part in brackets.
const coreTitle = (s) => norm(s.replace(/\s*[([].*?[)\]]/g, "")) || norm(s);
const has = (haystack, needle) => ` ${haystack} `.includes(` ${needle} `);

function isGoodVideo(song, video) {
  if (video.status?.privacyStatus !== "public" || video.status?.embeddable !== true) return false;
  const text = norm(`${video.snippet?.title ?? ""} ${video.snippet?.channelTitle ?? ""}`);
  return has(text, coreTitle(song.song)) && has(text, norm(song.artist));
}

// ---- Searching -------------------------------------------------------------------------------

let searches = 0, challengedBatches = 0, inARow = 0, stopReason = null;
const stop = (reason) => { stopReason ??= reason; };

// Returns { results: Map(query -> id), ok }. ok is false if the batch was challenged or failed outright.
async function search(songs, { urlFor, queryFromTitle, extra }) {
  searches += songs.length;
  let stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await run(
      YT_DLP,
      ["--ignore-config", "--flat-playlist", "--skip-download", "--no-warnings", "--ignore-errors", "--encoding", "utf-8",
        ...extra, "--print", "%(playlist_title)s\t%(id)s", ...songs.map((s) => urlFor(s.query))],
      { timeout: 300_000, maxBuffer: 1 << 24 }
    ));
  } catch (e) {
    stdout = e.stdout ?? "";
    stderr = `${e.stderr ?? ""} ${e.message ?? ""}`;
  }
  const results = new Map();
  for (const line of stdout.split("\n")) {
    const [title, id] = line.split("\t");
    if (title && id) results.set(queryFromTitle(title), id);
  }
  const challenged = CHALLENGE.test(stderr);
  if (challenged) {
    challengedBatches++;
    if (++inARow >= MAX_CHALLENGES_IN_A_ROW) stop(`YouTube challenged ${inARow} batches in a row`);
  } else {
    inARow = 0;
  }
  return { results, ok: !challenged && (stdout.trim() !== "" || stderr.trim() === "") };
}

const musicSearch = (songs) => search(songs, {
  urlFor: (q) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}#songs`,
  queryFromTitle: (t) => t.replace(/ - songs$/, ""),
  extra: ["--playlist-items", "1"],
});
const normalSearch = (songs) => search(songs, {
  urlFor: (q) => `ytsearch1:${q}`,
  queryFromTitle: (t) => t,
  extra: [],
});

let apiUnits = 0;
// Returns id -> video details, or null if the API refused, which stops the run.
async function lookUpVideos(ids) {
  const videos = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${unique.slice(i, i + 50).join(",")}&key=${encodeURIComponent(apiKey)}`;
    apiUnits++;
    let data;
    try {
      data = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).json();
    } catch (e) {
      stop(`YouTube API request failed (${e.name})`); // e.message could include the URL, which holds the key
      return null;
    }
    if (data.error) {
      stop(`YouTube API refused: ${data.error.errors?.[0]?.reason ?? data.error.code}`);
      return null;
    }
    for (const v of data.items ?? []) videos.set(v.id, v);
  }
  return videos;
}

// ---- Database --------------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-youtube-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));
const db = new DatabaseSync(localDb);
db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;");

// Changes this private temp copy only, which is deleted below. The real database gets these from apply-youtube-ids.mjs.
const columns = db.prepare("PRAGMA table_info(songs)").all().map((c) => c.name);
for (const column of ["youtube_id TEXT", "youtube_search_id TEXT", "youtube_search_source TEXT", "youtube_searched_at TEXT"]) {
  if (!columns.includes(column.split(" ")[0])) db.exec(`ALTER TABLE songs ADD COLUMN ${column}`);
}

db.exec(`
  CREATE TEMP TABLE eligible AS
  SELECT song_id, count(*) AS listeners
  FROM (SELECT user_id, song_id FROM user_songs UNION SELECT user_id, song_id FROM user_loved_songs)
  GROUP BY song_id
  HAVING listeners >= 2
`);
const WAITING = "s.youtube_id IS NULL AND s.youtube_search_id IS NULL AND s.youtube_searched_at IS NULL";
const queue = db.prepare(`
  SELECT s.id, s.name AS song, a.name AS artist, a.name || ' ' || s.name AS query
  FROM eligible e
  JOIN songs s ON s.id = e.song_id
  JOIN artists a ON a.id = s.artist_id
  WHERE ${WAITING}
  ORDER BY e.listeners DESC, s.id
  LIMIT ?
`).all(MAX_SONGS);
const waitingAtStart = db.prepare(`SELECT count(*) AS n FROM eligible e JOIN songs s ON s.id = e.song_id WHERE ${WAITING}`).get().n;
console.log(`Queued ${queue.length} songs, out of ${waitingAtStart} with 2+ listeners and no video`);
db.close();
fs.rmSync(workDir, { recursive: true, force: true });

fs.mkdirSync(path.dirname(path.resolve(resultsFile)), { recursive: true });
fs.writeFileSync(resultsFile, "");
// Written as it goes, so results survive if the job is stopped partway.
const save = (videoId, source, songId) => {
  fs.appendFileSync(resultsFile, `${JSON.stringify({ song: songId, video: videoId, source, at: new Date().toISOString() })}\n`);
};

// ---- Run -------------------------------------------------------------------------------------

let done = 0, fromMusic = 0, fromSearch = 0, noMatch = 0, retryLater = 0, next = 0;

// Saves the songs with a good video among these results, and returns the rest.
function keepGood(songs, found, videos, source) {
  const rest = [];
  for (const song of songs) {
    const id = found.get(song.query);
    const video = id && videos.get(id);
    if (video && isGoodVideo(song, video)) {
      save(id, source, song.id);
      done++;
      if (source === "music") fromMusic++; else fromSearch++;
    } else {
      rest.push(song);
    }
  }
  return rest;
}

async function processBatch(songs) {
  const music = await musicSearch(songs);
  if (stopReason) return;
  const musicVideos = await lookUpVideos([...music.results.values()]);
  if (!musicVideos) return;
  const afterMusic = keepGood(songs, music.results, musicVideos, "music");
  if (afterMusic.length === 0) return;

  const normal = await normalSearch(afterMusic);
  if (stopReason) return;
  const normalVideos = await lookUpVideos([...normal.results.values()]);
  if (!normalVideos) return;
  const afterNormal = keepGood(afterMusic, normal.results, normalVideos, "search");

  // Only a song that both searches really looked at is finished. The rest get another try on a later run.
  if (music.ok && normal.ok) {
    for (const song of afterNormal) { save(null, null, song.id); noMatch++; done++; }
  } else {
    retryLater += afterNormal.length;
  }
}

const batches = [];
for (let i = 0; i < queue.length; i += BATCH) batches.push(queue.slice(i, i + BATCH));

const progress = startProgress({
  label: "songs",
  total: queue.length,
  deadline,
  everySeconds: Number(args["log-seconds"] ?? 30),
  getCounts: () => ({
    done,
    errors: retryLater,
    requests: searches,
    rateLimited: challengedBatches,
    extra: `${fromMusic} from YouTube Music, ${fromSearch} from search, ${noMatch} no match`,
  }),
});

await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (!stopReason && next < batches.length && Date.now() < deadline) await processBatch(batches[next++]);
}));
progress.stop();

console.log(
  `YouTube search: ${fromMusic} from YouTube Music, ${fromSearch} from normal search, ${noMatch} no good match, ` +
  `${retryLater} to retry, ${waitingAtStart - done} left. ${searches} searches, ${challengedBatches} challenged batches, ${apiUnits} API units. ` +
  `Stopped: ${stopReason ?? (Date.now() >= deadline ? "time limit" : "queue finished")}`
);
if (stopReason) console.log(`::warning::YouTube search stopped early: ${stopReason}`);
