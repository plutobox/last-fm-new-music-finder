// Tests whether yt-dlp can search YouTube from this machine. Metadata only: it downloads no video or audio,
// uses no cookies or sign-in, and saves nothing. Songs come from the public songs.json.
// Usage: node scripts/test-youtube-search.mjs [--count 20] [--yt-dlp yt-dlp]
// With YOUTUBE_API_KEY set, it also asks YouTube whether each video found can be embedded.
//
// It stops after 3 challenges in a row, such as "Sign in to confirm you're not a bot". Getting past those isn't the goal.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const COUNT = Number(args.count ?? 20);
const YT_DLP = args["yt-dlp"] ?? "yt-dlp";
const SONGS_URL = "https://plutobox.github.io/last-fm-new-music-finder/data/songs.json";
const DELAY_MS = 3000;
const MAX_CHALLENGES_IN_A_ROW = 3;
const CHALLENGE = /sign in to confirm|not a bot|http error 429|too many requests/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const file = await (await fetch(SONGS_URL)).json();
const col = Object.fromEntries(file.columns.map((name, i) => [name, i]));
const songs = file.rows.filter((r) => !r[col.youtube_id]).slice(0, COUNT);
console.log(`Testing ${songs.length} of the most-listened songs with no video`);

let found = 0, empty = 0, failed = 0, challenged = 0, inARow = 0, titleMatches = 0, artistMatches = 0;
const results = [];
const started = Date.now();
for (const r of songs) {
  const artist = r[col.artist], song = r[col.song];
  try {
    const { stdout } = await run(
      YT_DLP,
      ["--ignore-config", "--flat-playlist", "--skip-download", "--no-warnings", "--print", "%(id)s\t%(title)s\t%(channel)s", `ytsearch1:${artist} ${song}`],
      { timeout: 60_000 }
    );
    inARow = 0;
    const [id, title = "", channel = ""] = stdout.trim().split("\t");
    if (!id) {
      empty++;
      console.log(`none   | ${artist} - ${song}`);
    } else {
      found++;
      const hay = norm(`${title} ${channel}`);
      const titleOk = hay.includes(norm(song)), artistOk = hay.includes(norm(artist));
      if (titleOk) titleMatches++;
      if (artistOk) artistMatches++;
      results.push({ id, artist, song, title });
      console.log(`${titleOk && artistOk ? "match " : "check "} | ${artist} - ${song} => ${title} [${id}]`);
    }
  } catch (e) {
    const text = `${e.stderr ?? ""} ${e.message ?? ""}`;
    if (CHALLENGE.test(text)) {
      challenged++;
      console.log(`CHALLENGED | ${artist} - ${song}`);
      if (++inARow >= MAX_CHALLENGES_IN_A_ROW) { console.log(`Stopping: challenged ${inARow} times in a row`); break; }
    } else {
      failed++;
      console.log(`failed | ${artist} - ${song} | ${text.trim().split("\n").at(-1)?.slice(0, 160)}`);
    }
  }
  await sleep(DELAY_MS);
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\nSearched in ${seconds}s: ${found} found, ${empty} no result, ${challenged} challenged, ${failed} failed.`);
console.log(`Of those found: song title matches ${titleMatches}, artist named ${artistMatches}.`);

const key = process.env.YOUTUBE_API_KEY;
if (key && results.length) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${results.slice(0, 50).map((x) => x.id).join(",")}&key=${encodeURIComponent(key)}`);
  const data = await res.json();
  if (data.error) console.log(`API check failed: ${data.error.errors?.[0]?.reason}`);
  else {
    const playable = data.items.filter((v) => v.status.privacyStatus === "public" && v.status.embeddable).length;
    console.log(`YouTube API: ${playable} of ${results.slice(0, 50).length} can play in the site's player.`);
  }
}
