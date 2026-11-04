// Moves the encrypted database between a local folder and the repo's "database" GitHub Release.
// Usage: node scripts/release-store.mjs download <dir>
//        node scripts/release-store.mjs upload <dir>
// Needs the gh CLI, logged in locally or with GH_TOKEN set in Actions.
//
// Each upload is a new generation, named g<timestamp>.users.db.age.000 and so on, finished by a marker file,
// g<timestamp>.complete.<part count>. Downloads only use the newest generation with a marker, so a failed
// upload can never replace good data. Old generations are removed only after a new one is fully uploaded,
// keeping the newest and one backup.
//
// There's deliberately no "start empty" fallback: if the release can't be read, this fails, because carrying on
// could overwrite the real database with a new empty one.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.GITHUB_REPOSITORY ?? "plutobox/last-fm-new-music-finder";
const TAG = process.env.DATABASE_RELEASE_TAG ?? "database";
const KEEP_GENERATIONS = 2;
const BASE = "users.db.age";

const gh = (...args) => execFileSync("gh", [...args, "-R", REPO], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function listAssets() {
  return JSON.parse(gh("release", "view", TAG, "--json", "assets")).assets.map((a) => ({ name: a.name, size: a.size }));
}

// Newest first. complete = the marker exists and every part it promises is there.
function generations(assets) {
  const byGen = new Map();
  for (const a of assets) {
    const m = a.name.match(/^g(\d+)\.(.+)$/);
    if (!m) continue;
    if (!byGen.has(m[1])) byGen.set(m[1], { id: m[1], parts: [], expected: null, all: [] });
    const g = byGen.get(m[1]);
    g.all.push(a.name);
    const marker = m[2].match(/^complete\.(\d+)$/);
    if (marker) g.expected = Number(marker[1]);
    else if (m[2].startsWith(`${BASE}.`)) g.parts.push(a.name);
  }
  return [...byGen.values()]
    .map((g) => ({ ...g, complete: g.expected !== null && g.parts.length === g.expected }))
    .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

function download(dir) {
  const latest = generations(listAssets()).find((g) => g.complete);
  if (!latest) throw new Error(`Release ${TAG} has no complete database`);
  fs.mkdirSync(dir, { recursive: true });
  gh("release", "download", TAG, "-p", `g${latest.id}.${BASE}.*`, "-D", dir, "--clobber");
  for (const name of latest.parts) {
    fs.renameSync(path.join(dir, name), path.join(dir, name.slice(`g${latest.id}.`.length)));
  }
  console.log(`Downloaded ${latest.parts.length} file(s) from release ${TAG}`);
}

function upload(dir) {
  const local = fs.readdirSync(dir)
    .filter((f) => f === BASE || (f.startsWith(`${BASE}.`) && /^\d+$/.test(f.slice(BASE.length + 1))))
    .sort();
  if (local.length === 0) throw new Error(`No ${BASE} files in ${dir}`);

  const id = String(Date.now());
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lfm-release-"));
  try {
    const expected = new Map();
    for (const [i, f] of local.entries()) {
      const name = `g${id}.${BASE}.${String(i).padStart(3, "0")}`;
      const file = path.join(work, name);
      fs.copyFileSync(path.join(dir, f), file);
      expected.set(name, fs.statSync(file).size);
      gh("release", "upload", TAG, file);
      fs.rmSync(file);
    }

    // Only publish the marker once the release reports every part at the right size.
    const uploaded = new Map(listAssets().map((a) => [a.name, a.size]));
    for (const [name, size] of expected) {
      if (uploaded.get(name) !== size) throw new Error(`Upload check failed for ${name}: ${uploaded.get(name)} != ${size} bytes`);
    }
    const marker = path.join(work, `g${id}.complete.${local.length}`);
    fs.writeFileSync(marker, "complete\n"); // GitHub rejects empty files
    gh("release", "upload", TAG, marker);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`Uploaded ${local.length} file(s) to release ${TAG}`);

  // The new data is safe by now, so a cleanup problem shouldn't fail the run.
  try {
    const gens = generations(listAssets());
    const keep = new Set(gens.filter((g) => g.complete).slice(0, KEEP_GENERATIONS).map((g) => g.id));
    let removed = 0;
    for (const g of gens) {
      if (keep.has(g.id)) continue;
      for (const name of g.all) { gh("release", "delete-asset", TAG, name, "--yes"); removed++; }
    }
    console.log(`Kept ${keep.size} version(s), removed ${removed} old file(s)`);
  } catch (e) {
    console.log(`::warning::Couldn't remove old database versions: ${e.message}`);
  }
}

const [command, dir] = process.argv.slice(2);
if (command === "download" && dir) download(dir);
else if (command === "upload" && dir) upload(dir);
else throw new Error("usage: node scripts/release-store.mjs <download|upload> <dir>");
