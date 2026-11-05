// Publishes the output of export-similar.mjs into the site's data folder. Songs in the new files replace their old
// entries, and every other song keeps what it had, so a run for a few songs or one that hit its time limit loses nothing.
// Usage: node scripts/merge-similar.mjs --from similar-out --into pages/data/similar
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const from = args.from, into = args.into;
if (!from || !into) throw new Error("--from and --into are required");

const newManifest = JSON.parse(fs.readFileSync(path.join(from, "manifest.json"), "utf8"));
const manifestPath = path.join(into, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const old = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // A song's file depends on the number of files, so changing it would strand every older entry.
  if (old.shards !== newManifest.shards) throw new Error(`file count changed from ${old.shards} to ${newManifest.shards}`);
}

fs.mkdirSync(into, { recursive: true });
let songs = 0, files = 0;
for (const name of fs.readdirSync(from)) {
  if (!/^\d+\.json$/.test(name)) continue;
  const fresh = JSON.parse(fs.readFileSync(path.join(from, name), "utf8"));
  const target = path.join(into, name);
  const merged = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
  Object.assign(merged, fresh);
  const lines = Object.entries(merged).map(([id, matches]) => `${JSON.stringify(id)}:${JSON.stringify(matches)}`);
  fs.writeFileSync(target, `{\n${lines.join(",\n")}\n}\n`);
  songs += Object.keys(fresh).length;
  files++;
}
// Last, so a stopped run can't announce files that aren't there.
fs.writeFileSync(manifestPath, `${JSON.stringify(newManifest, null, 1)}\n`);
console.log(`Merged ${songs} songs into ${files} file(s)`);
