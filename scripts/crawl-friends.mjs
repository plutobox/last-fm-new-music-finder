// Breadth-first crawl of Last.fm friends via user.getFriends, stored in a SQLite database.
// Usage: node scripts/crawl-friends.mjs --seeds a,b --depth 2 --max-users 500 --db data/users.db
//        node scripts/crawl-friends.mjs --random-seeds 5 --db data/users.db.age [--import-json data/users.json.age]
//
// --random-seeds N  picks N random users whose friends haven't been fetched yet (used when --seeds is empty).
// --max-users N     caps how many users NOT already in the database are added this run.
// --max-pages N     friend-list pages (200 each) fetched per user, default 3.
// --import-json P   one-time migration: if the database has no users, load them from the old users.json(.age).
//
// Each user's friends are fetched at most once ever (users.crawled_at); later runs walk the stored
// friendships table instead of calling the API again.
//
// Needs LAST_FM_API_KEY (and optionally LAST_FM_APPLICATION_NAME for the User-Agent) in the environment.
// If --db ends in ".age", it's read from and written to split encrypted files (see db-store.mjs);
// LAST_FM_AGE_IDENTITY (an age private key) must be set. The recipient is derived from it.
//
// Logs only print counts, never usernames: Actions logs on a public repo are public.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Decrypter } from "age-encryption";
import { encryptedDbExists, readEncryptedDb, writeEncryptedDb, DEFAULT_PART_MB } from "./db-store.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const apiKey = process.env.LAST_FM_API_KEY;
if (!apiKey) throw new Error("LAST_FM_API_KEY is not set");

const explicitSeeds = (args.seeds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const randomSeeds = Number(args["random-seeds"] ?? 0);
const maxDepth = Number(args.depth ?? 2);
const maxUsers = Number(args["max-users"] ?? 500);
const maxPagesPerUser = Number(args["max-pages"] ?? 3);
const dbPath = args.db ?? "data/users.db";
const importJson = args["import-json"];
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
const needsKey = dbPath.endsWith(".age") || importJson?.endsWith(".age");
if (needsKey && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but a .age file was given");
const userAgent = process.env.LAST_FM_APPLICATION_NAME ?? "last-fm-new-music-finder";
const DELAY_MS = 250; // ~4 req/s, under Last.fm's ~5/s limit

if (explicitSeeds.length === 0 && !(randomSeeds > 0)) {
  throw new Error("No seeds given (--seeds a,b,c or --random-seeds N)");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const int = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

async function decrypt(file) {
  const d = new Decrypter();
  d.addIdentity(ageIdentity);
  return d.decrypt(fs.readFileSync(file)); // Uint8Array
}

// ---- Last.fm ---------------------------------------------------------------------------------

let requests = 0;
async function getFriendsPage(user, page) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method: "user.getFriends", user, page: String(page), limit: "200",
    api_key: apiKey, format: "json",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(DELAY_MS);
    requests++;
    const res = await fetch(url, { headers: { "User-Agent": userAgent } });
    const data = await res.json().catch(() => ({}));
    if (data.error === 29 || res.status === 429 || res.status >= 500) { // rate limited / server
      await sleep(2000 * (attempt + 1));
      continue;
    }
    // Only 6 (not found) and 17 (private) are about this user. Others, like a bad API key, must not mark them done.
    if (data.error) return { friends: [], error: `${data.error}: ${data.message ?? ""}`.trim(), permanent: data.error === 6 || data.error === 17 };
    const f = data.friends?.user ?? [];
    const attr = data.friends?.["@attr"] ?? {};
    return {
      friends: Array.isArray(f) ? f : [f],
      totalPages: Number(attr.totalPages ?? 1),
      total: int(attr.total),
    };
  }
  return { friends: [], error: "retries-exhausted", permanent: false };
}

// ---- Database --------------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-crawl-"));
const encrypted = dbPath.endsWith(".age");
const localDb = encrypted ? path.join(workDir, "users.db") : dbPath;
if (encrypted && encryptedDbExists(dbPath)) fs.writeFileSync(localDb, await readEncryptedDb(dbPath, ageIdentity));
fs.mkdirSync(path.dirname(localDb), { recursive: true });

const db = new DatabaseSync(localDb);
db.exec(`
  PRAGMA journal_mode = DELETE;  -- single self-contained file, since it gets encrypted and shipped
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    name               TEXT PRIMARY KEY COLLATE NOCASE,
    realname           TEXT,
    url                TEXT,
    country            TEXT,
    image_url          TEXT,     -- largest avatar size
    registered_at      INTEGER,  -- unix seconds
    subscriber         INTEGER,  -- 1 = Last.fm Pro
    type               TEXT,     -- user / subscriber / staff / ...
    playcount          INTEGER,  -- as reported by user.getFriends (often 0 there)
    playlists          INTEGER,
    bootstrap          INTEGER,
    depth              INTEGER,  -- fewest friend-hops from any seed we've seen
    discovered_via     TEXT COLLATE NOCASE,  -- whose friend list we first found them in
    discovered_at      TEXT NOT NULL,
    details_updated_at TEXT,     -- last time a friends payload included this user
    friends_total      INTEGER,  -- their friend count per Last.fm
    crawled_at         TEXT,     -- when their friends were fetched; NULL = not yet
    crawl_error        TEXT
  );
  CREATE INDEX IF NOT EXISTS users_uncrawled ON users (name) WHERE crawled_at IS NULL;

  CREATE TABLE IF NOT EXISTS friendships (
    user          TEXT NOT NULL COLLATE NOCASE REFERENCES users (name),
    friend        TEXT NOT NULL COLLATE NOCASE REFERENCES users (name),
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (user, friend)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS friendships_friend ON friendships (friend);

  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    seed_count  INTEGER,
    new_users   INTEGER,
    requests    INTEGER,
    errors      INTEGER
  );

  PRAGMA user_version = 1;
`);

const tx = (fn) => {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
};

const q = {
  get: db.prepare("SELECT name, depth, crawled_at FROM users WHERE name = ?"),
  insertBare: db.prepare(
    "INSERT INTO users (name, depth, discovered_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING"
  ),
  upsertFriend: db.prepare(`
    INSERT INTO users (name, realname, url, country, image_url, registered_at, subscriber, type,
                       playcount, playlists, bootstrap, depth, discovered_via, discovered_at, details_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET
      realname = excluded.realname, url = excluded.url, country = excluded.country,
      image_url = excluded.image_url, registered_at = excluded.registered_at,
      subscriber = excluded.subscriber, type = excluded.type, playcount = excluded.playcount,
      playlists = excluded.playlists, bootstrap = excluded.bootstrap,
      details_updated_at = excluded.details_updated_at,
      depth = MIN(COALESCE(users.depth, excluded.depth), excluded.depth)
  `),
  edge: db.prepare(
    "INSERT INTO friendships (user, friend, first_seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
  ),
  storedFriends: db.prepare("SELECT friend FROM friendships WHERE user = ?"),
  markCrawled: db.prepare(
    "UPDATE users SET crawled_at = ?, friends_total = COALESCE(?, friends_total), crawl_error = ? WHERE name = ?"
  ),
  markError: db.prepare("UPDATE users SET crawl_error = ? WHERE name = ?"),
  randomUncrawled: db.prepare(
    "SELECT name FROM users WHERE crawled_at IS NULL ORDER BY random() LIMIT ?"
  ),
  count: db.prepare("SELECT count(*) AS n FROM users"),
};

// One-time migration from the old JSON list.
if (importJson && q.count.get().n === 0 && fs.existsSync(importJson)) {
  const raw = importJson.endsWith(".age")
    ? new TextDecoder().decode(await decrypt(importJson))
    : fs.readFileSync(importJson, "utf8");
  const old = JSON.parse(raw);
  const at = old.generatedAt ?? now();
  tx(() => { for (const u of old.users) q.insertBare.run(u.name, u.depth ?? null, at); });
  console.log(`Imported ${old.users.length} users from the old JSON list`);
}

// ---- Crawl -----------------------------------------------------------------------------------

const startedAt = now();
const runId = db.prepare("INSERT INTO runs (started_at) VALUES (?)").run(startedAt).lastInsertRowid;

let seeds = explicitSeeds;
if (seeds.length === 0) {
  seeds = q.randomUncrawled.all(randomSeeds).map((r) => r.name);
  if (seeds.length === 0) throw new Error("--random-seeds found no uncrawled users in the database");
}
tx(() => { for (const s of seeds) q.insertBare.run(s, 0, startedAt); });
console.log(`Seeds: ${seeds.length}`);

let added = 0, errors = 0;
const full = () => added >= maxUsers;
const visited = new Set(); // lowercase names expanded or queued this run

function saveFriends(user, userDepth, friends) {
  const at = now();
  const names = [];
  tx(() => {
    for (const f of friends) {
      if (full()) break;
      const isNew = !q.get.get(f.name);
      const img = Array.isArray(f.image) ? f.image.at(-1)?.["#text"] || null : null;
      q.upsertFriend.run(
        f.name, f.realname || null, f.url || null,
        f.country && f.country !== "None" ? f.country : null, img,
        int(f.registered?.unixtime), int(f.subscriber), f.type || null,
        int(f.playcount), int(f.playlists), int(f.bootstrap),
        userDepth + 1, user, at, at,
      );
      q.edge.run(user, f.name, at);
      if (isNew) added++;
      names.push(f.name);
    }
  });
  return names;
}

// Returns the user's friend names, from the API the first time and from the database after that.
async function expand(name) {
  const row = q.get.get(name);
  const depth = row?.depth ?? 0;
  if (row?.crawled_at) return q.storedFriends.all(name).map((r) => r.friend);

  const names = [];
  let page = 1, totalPages = 1, total = null, stoppedEarly = false;
  while (page <= Math.min(totalPages, maxPagesPerUser)) {
    if (full()) { stoppedEarly = true; break; }
    const r = await getFriendsPage(name, page);
    if (r.error) {
      errors++;
      // Permanent errors (private / deleted user) are marked crawled so they aren't retried.
      if (r.permanent) q.markCrawled.run(now(), null, r.error, name);
      else q.markError.run(r.error, name);
      return names;
    }
    totalPages = r.totalPages;
    total = r.total;
    const pageNames = saveFriends(name, depth, r.friends);
    names.push(...pageNames);
    if (pageNames.length < r.friends.length) stoppedEarly = true; // hit --max-users mid-page
    page++;
  }
  // Only mark crawled once every page we intended to read was read.
  if (!stoppedEarly) q.markCrawled.run(now(), total, null, name);
  return names;
}

let frontier = [];
for (const s of seeds) if (!visited.has(s.toLowerCase())) { visited.add(s.toLowerCase()); frontier.push(s); }

for (let depth = 0; depth < maxDepth && frontier.length && !full(); depth++) {
  const next = [];
  let expanded = 0;
  for (const user of frontier) {
    if (full()) break;
    expanded++;
    for (const f of await expand(user)) {
      const key = f.toLowerCase();
      if (!visited.has(key)) { visited.add(key); next.push(f); }
    }
  }
  console.log(
    `depth ${depth}: expanded ${expanded} of ${frontier.length} queued users, ` +
    `new so far ${added}, requests ${requests}`
  );
  frontier = next;
}

db.prepare(
  "UPDATE runs SET finished_at = ?, seed_count = ?, new_users = ?, requests = ?, errors = ? WHERE id = ?"
).run(now(), seeds.length, added, requests, errors, runId);

const total = q.count.get().n;
const uncrawled = db.prepare("SELECT count(*) AS n FROM users WHERE crawled_at IS NULL").get().n;
const edges = db.prepare("SELECT count(*) AS n FROM friendships").get().n;
db.exec("VACUUM");
db.close();

if (encrypted) await writeEncryptedDb(dbPath, ageIdentity, fs.readFileSync(localDb), Number(args["part-mb"] ?? DEFAULT_PART_MB));
fs.rmSync(workDir, { recursive: true, force: true });

console.log(
  `Wrote ${dbPath}: ${total} users (${uncrawled} not crawled yet), ${edges} friendships. ` +
  `New this run: ${added}, requests: ${requests}, errors: ${errors}`
);
