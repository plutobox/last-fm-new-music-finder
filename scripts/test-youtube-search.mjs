// Tests how fast yt-dlp can search YouTube from this machine. Metadata only: it downloads no video or audio,
// uses no cookies or sign-in, and saves nothing. Songs come from the public songs.json.
// Usage: node scripts/test-youtube-search.mjs [--count 200] [--workers 4] [--batch 25] [--yt-dlp yt-dlp]
// With YOUTUBE_API_KEY set, it also asks YouTube whether the matching videos can be embedded.
//
// One process handles a whole batch, because starting yt-dlp is the slow part. Workers each run one batch at a time.
// Everything stops after 3 challenged batches in a row, such as "Sign in to confirm you're not a bot".
// Getting past those isn't the goal.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const COUNT = Number(args.count ?? 200);
const WORKERS = Number(args.workers ?? 4);
const BATCH = Number(args.batch ?? 25);
const YT_DLP = args["yt-dlp"] ?? "yt-dlp";
const SONGS_URL = "https://plutobox.github.io/last-fm-new-music-finder/data/songs.json";
const MAX_CHALLENGES_IN_A_ROW = 3;
const CHALLENGE = /sign in to confirm|not a bot|http error 429|too many requests/i;

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const file = await (await fetch(SONGS_URL)).json();
const col = Object.fromEntries(file.columns.map((name, i) => [name, i]));
const songs = file.rows.filter((r) => !r[col.youtube_id]).slice(0, COUNT)
  .map((r) => ({ artist: r[col.artist], song: r[col.song], query: `${r[col.artist]} ${r[col.song]}` }));
console.log(`Testing ${songs.length} of the most-listened songs with no video: ${WORKERS} workers, ${BATCH} per batch`);

const batches = [];
for (let i = 0; i < songs.length; i += BATCH) batches.push(songs.slice(i, i + BATCH));

let next = 0, stopped = false, challengedBatches = 0, inARow = 0, failedBatches = 0;
const results = new Map(); // query -> { id, title, channel }

async function runBatch(batch) {
  let stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await run(
      YT_DLP,
      [
        "--ignore-config", "--flat-playlist", "--skip-download", "--no-warnings", "--ignore-errors", "--encoding", "utf-8",
        "--print", "%(playlist_title)s\t%(id)s\t%(title)s\t%(channel)s",
        ...batch.map((s) => `ytsearch1:${s.query}`),
      ],
      { timeout: 300_000, maxBuffer: 1 << 24 }
    ));
  } catch (e) {
    // With --ignore-errors some searches can fail while others still print results, so keep what came back.
    stdout = e.stdout ?? "";
    stderr = `${e.stderr ?? ""} ${e.message ?? ""}`;
  }
  for (const line of stdout.split("\n")) {
    const [query, id, title = "", channel = ""] = line.split("\t");
    if (query && id) results.set(query, { id, title, channel });
  }
  if (CHALLENGE.test(stderr)) {
    challengedBatches++;
    console.log(`CHALLENGED batch (${challengedBatches} so far)`);
    if (++inARow >= MAX_CHALLENGES_IN_A_ROW) { stopped = true; console.log(`Stopping: ${inARow} challenged batches in a row`); }
  } else {
    inARow = 0;
    if (stderr.trim() && !stdout.trim()) { failedBatches++; console.log(`failed batch: ${stderr.trim().split("\n").at(-1).slice(0, 160)}`); }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (!stopped && next < batches.length) await runBatch(batches[next++]);
}));
const seconds = (Date.now() - started) / 1000;

let accepted = 0, rejected = 0, noResult = 0;
const good = [], sampleRejected = [];
for (const s of songs) {
  const r = results.get(s.query);
  if (!r) { noResult++; continue; }
  const hay = norm(`${r.title} ${r.channel}`);
  // The same check a saving version would use: an unrelated video is worse than none.
  if (hay.includes(norm(s.artist)) && hay.includes(norm(s.song))) { accepted++; good.push(r.id); }
  else { rejected++; if (sampleRejected.length < 12) sampleRejected.push(`${s.artist} - ${s.song} => ${r.title}`); }
}

console.log(`\n${results.size} results in ${seconds.toFixed(0)}s: ${(results.size / seconds).toFixed(2)} searches a second.`);
console.log(`Batches: ${batches.length} planned, ${challengedBatches} challenged, ${failedBatches} failed${stopped ? ", stopped early" : ""}.`);
console.log(`Songs: ${accepted} matched, ${rejected} rejected by the title check, ${noResult} no result.`);
for (const line of sampleRejected) console.log(`  rejected: ${line.slice(0, 130)}`);

const key = process.env.YOUTUBE_API_KEY;
if (key && good.length) {
  let playable = 0, checked = 0;
  for (let i = 0; i < good.length; i += 50) {
    const ids = good.slice(i, i + 50);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${ids.join(",")}&key=${encodeURIComponent(key)}`);
    const data = await res.json();
    if (data.error) { console.log(`API check failed: ${data.error.errors?.[0]?.reason}`); break; }
    checked += ids.length;
    playable += data.items.filter((v) => v.status.privacyStatus === "public" && v.status.embeddable).length;
  }
  console.log(`YouTube API: ${playable} of ${checked} matched videos can play in the site's player.`);
}
