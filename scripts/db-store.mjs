// Reads and writes the encrypted database: gzip, then age-encrypt, then split into numbered files.
// For --db data/users.db.age the files are data/users.db.age.000, .001, ... so no file passes GitHub's
// 100 MB limit. Join them in order and you have one age file. A single unsplit file is still readable.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Encrypter, Decrypter, identityToRecipient } from "age-encryption";

export const DEFAULT_PART_MB = 90;

function partFiles(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) return [];
  const prefix = `${path.basename(dbPath)}.`;
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && /^\d{3,}$/.test(f.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
    .map((f) => path.join(dir, f));
}

export function encryptedDbExists(dbPath) {
  return fs.existsSync(dbPath) || partFiles(dbPath).length > 0;
}

// Returns the plain SQLite file's bytes.
export async function readEncryptedDb(dbPath, identity) {
  const parts = partFiles(dbPath);
  const files = parts.length ? parts : [dbPath];
  const d = new Decrypter();
  d.addIdentity(identity);
  const bytes = await d.decrypt(Buffer.concat(files.map((f) => fs.readFileSync(f))));
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b; // older copies weren't compressed
  return isGzip ? zlib.gunzipSync(bytes) : bytes;
}

// Returns how many files were written.
export async function writeEncryptedDb(dbPath, identity, plainBytes, partMb = DEFAULT_PART_MB) {
  const partBytes = Math.floor(partMb * 1024 * 1024);
  if (!(partBytes > 0)) throw new Error("part size must be positive");
  const e = new Encrypter();
  e.addRecipient(await identityToRecipient(identity));
  const out = await e.encrypt(zlib.gzipSync(plainBytes));

  const old = partFiles(dbPath);
  if (fs.existsSync(dbPath)) old.push(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const written = new Set();
  for (let i = 0, offset = 0; offset < out.length; i++, offset += partBytes) {
    const file = path.join(path.dirname(dbPath), `${path.basename(dbPath)}.${String(i).padStart(3, "0")}`);
    fs.writeFileSync(file, out.subarray(offset, offset + partBytes));
    written.add(file);
  }
  for (const f of old) if (!written.has(f)) fs.rmSync(f); // never leave a stale part to be joined later
  return written.size;
}
