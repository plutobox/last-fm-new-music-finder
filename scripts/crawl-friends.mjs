// Breadth-first crawl of Last.fm friends via user.getFriends.
// Usage: node scripts/crawl-friends.mjs --seeds a,b --depth 2 --max-users 500 --out data/users.json
// Needs LAST_FM_API_KEY (and optionally LAST_FM_APPLICATION_NAME for the User-Agent) in the environment.
// If --out ends in ".age", the file is read/written encrypted; LAST_FM_AGE_IDENTITY (an age private key)
// must be set. The public recipient is derived from it, so only one secret is needed.
import fs from "node:fs";
import path from "node:path";
import { Encrypter, Decrypter, identityToRecipient } from "age-encryption";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);

const apiKey = process.env.LAST_FM_API_KEY;
if (!apiKey) throw new Error("LAST_FM_API_KEY is not set");

const seeds = (args.seeds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const maxDepth = Number(args.depth ?? 2);
const maxUsers = Number(args["max-users"] ?? 500);
const maxPagesPerUser = Number(args["max-pages"] ?? 3);
const out = args.out ?? "data/users.json";
const encrypted = out.endsWith(".age");
const ageIdentity = process.env.LAST_FM_AGE_IDENTITY?.trim();
if (encrypted && !ageIdentity) throw new Error("LAST_FM_AGE_IDENTITY is not set but --out is a .age file");
const userAgent = process.env.LAST_FM_APPLICATION_NAME ?? "last-fm-new-music-finder";
const DELAY_MS = 250; // ~4 req/s, under Last.fm's ~5/s limit

if (seeds.length === 0) throw new Error("No seeds given (--seeds a,b,c)");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFriendsPage(user, page) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method: "user.getFriends", user, page: String(page), limit: "200",
    api_key: apiKey, format: "json",
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(DELAY_MS);
    const res = await fetch(url, { headers: { "User-Agent": userAgent } });
    const data = await res.json().catch(() => ({}));
    if (data.error === 29 || res.status === 429 || res.status >= 500) { // rate limited / server
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (data.error) return { friends: [], totalPages: 0, error: data.error };
    const f = data.friends?.user ?? [];
    return {
      friends: (Array.isArray(f) ? f : [f]).map((u) => u.name),
      totalPages: Number(data.friends?.["@attr"]?.totalPages ?? 1),
    };
  }
  return { friends: [], totalPages: 0, error: "retries-exhausted" };
}

// Merge with any existing file so the list grows over runs.
async function readStore() {
  if (!fs.existsSync(out)) return { users: [] };
  if (!encrypted) return JSON.parse(fs.readFileSync(out, "utf8"));
  const d = new Decrypter();
  d.addIdentity(ageIdentity);
  return JSON.parse(await d.decrypt(fs.readFileSync(out), "text"));
}

async function writeStore(obj) {
  const text = JSON.stringify(obj) + "\n";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!encrypted) return fs.writeFileSync(out, JSON.stringify(obj, null, 1) + "\n");
  const e = new Encrypter();
  e.addRecipient(await identityToRecipient(ageIdentity));
  fs.writeFileSync(out, await e.encrypt(text));
}

const existing = await readStore();
const known = new Map(existing.users.map((u) => [u.name.toLowerCase(), u]));

const seen = new Map(); // lowercase -> { name, depth }
let frontier = [];
for (const s of seeds) {
  seen.set(s.toLowerCase(), { name: s, depth: 0 });
  frontier.push(s);
}

let skipped = 0;
for (let depth = 0; depth < maxDepth && frontier.length && seen.size < maxUsers; depth++) {
  const next = [];
  for (const user of frontier) {
    if (seen.size >= maxUsers) break;
    let page = 1, total = 1;
    while (page <= Math.min(total, maxPagesPerUser) && seen.size < maxUsers) {
      const r = await getFriendsPage(user, page);
      if (r.error) { skipped++; break; }
      total = r.totalPages;
      for (const f of r.friends) {
        const key = f.toLowerCase();
        if (!seen.has(key) && seen.size < maxUsers) {
          seen.set(key, { name: f, depth: depth + 1 });
          next.push(f);
        }
      }
      page++;
    }
    console.log(`depth ${depth} ${user}: total unique so far ${seen.size}`);
  }
  frontier = next;
}

for (const [key, u] of seen) if (!known.has(key)) known.set(key, u);

const users = [...known.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
await writeStore({ generatedAt: new Date().toISOString(), seeds, count: users.length, users });
console.log(`Wrote ${users.length} users to ${out} (new this run: ${seen.size}, skipped/private: ${skipped})`);
