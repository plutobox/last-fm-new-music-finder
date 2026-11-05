// Fetches total listens for users still waiting for their songs, via user.getInfo, so fetch-top-tracks.mjs can start
// with the most active users. One request per user, once ever, tracked by users.profile_fetched_at. Most friends first.
// Usage: node scripts/fetch-user-info.mjs --db db/users.db.age [--max-users 5000] [--minutes 10]
//                                         [--concurrency 3] [--max-per-second 4]
//
// Needs LAST_FM_API_KEY. A ".age" --db also needs LAST_FM_AGE_IDENTITY. Logs print counts only, never usernames.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptedDbExists, readEncryptedDb, writeEncryptedDb, DEFAULT_PART_MB } from "./db-store.mjs";
import { createClient } from "./lastfm-client.mjs";
import { startProgress } from "./progress.mjs";
import { addProfileColumns, FRIEND_COUNTS, FRIENDS, LIKELY_BOT_PLAYS_PER_DAY, PLAYS_PER_DAY } from "./user-activity.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const apiKey = process.env.LAST_FM_API_KEY;
if (!apiKey) throw new Error("LAST_FM_API_KEY is not set");

const MAX_CONSECUTIVE_FAILURES = 20;
const dbPath = args.db ?? "data/users.db";
const maxUsers = Number(args["max-users"] ?? 5000);
const deadline = Date.now() + Number(args.minutes ?? 10) * 60_000;
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-profiles-"));
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));

const db = new DatabaseSync(localDb);
db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF;");
addProfileColumns(db);

const WAITING = "(u.songs_fetched_at IS NULL OR u.loved_fetched_at IS NULL) AND u.profile_fetched_at IS NULL";
const queue = db.prepare(`
  WITH ${FRIEND_COUNTS}
  SELECT u.name FROM users u LEFT JOIN friend_counts f ON f.name = u.name COLLATE NOCASE
  WHERE ${WAITING}
  ORDER BY ${FRIENDS} DESC, random()
  LIMIT ?
`).all(maxUsers);
const countLeft = db.prepare(`SELECT count(*) AS n FROM users u WHERE ${WAITING}`);
console.log(`Queued ${queue.length} users, out of ${countLeft.get().n} with no total listens yet`);

const saveProfile = db.prepare(`
  UPDATE users SET total_plays = ?, total_artists = ?, total_tracks = ?, total_albums = ?, profile_fetched_at = ?, profile_error = NULL
  WHERE name = ?
`);
const saveError = db.prepare("UPDATE users SET profile_fetched_at = ?, profile_error = ? WHERE name = ?");
const count = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; };

let fetched = 0, errored = 0, consecutiveFailures = 0, next = 0, stopped = false, stopReason = "queue finished";
const stop = (reason) => { if (!stopped) stopReason = reason; stopped = true; };

const progress = startProgress({
  label: "users",
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
    const user = queue[next++];
    const r = await client.apiGet({ method: "user.getInfo", user: user.name }, "user");
    if (r.error) {
      if (r.kind === "fatal") { stop(`Last.fm stopped us: ${r.error}`); break; }
      if (r.kind === "transient") {
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stop(`repeated failures (${r.error})`);
        continue; // left unfetched, so a later run retries this user
      }
      saveError.run(new Date().toISOString(), r.error, user.name);
      errored++;
      consecutiveFailures = 0;
      continue;
    }
    saveProfile.run(count(r.playcount), count(r.artist_count), count(r.track_count), count(r.album_count), new Date().toISOString(), user.name);
    fetched++;
    consecutiveFailures = 0;
  }
}));

progress.stop();

const left = countLeft.get().n;
// Counts only, to check the likely-bot cutoff against real numbers.
const rates = db.prepare(`SELECT ${PLAYS_PER_DAY} AS r FROM users u WHERE u.total_plays > 0 AND u.registered_at > 0 ORDER BY r`).all().map((x) => x.r);
const percentile = (p) => (rates.length ? Math.round(rates[Math.min(rates.length - 1, Math.floor(rates.length * p))]) : 0);
const likelyBots = rates.filter((r) => r >= LIKELY_BOT_PLAYS_PER_DAY).length;
db.close();
console.log("Saving the database...");
if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), Number(args["part-mb"] ?? DEFAULT_PART_MB));
fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `User profiles: ${fetched} fetched, ${errored} errored, ${left} left, ${client.stats.requests} requests ` +
  `(${client.stats.rateLimited} rate limited). Stopped: ${stopReason}`
);
console.log(
  `Listens a day across ${rates.length} users: median ${percentile(0.5)}, 90th percentile ${percentile(0.9)}, 99th ${percentile(0.99)}, ` +
  `highest ${percentile(1)}. ${likelyBots} at or above the likely-bot cutoff of ${LIKELY_BOT_PLAYS_PER_DAY}.`
);
if (!/queue finished|time limit/.test(stopReason)) console.log(`::warning::Stopped early: ${stopReason}`);
