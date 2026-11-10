// Reads and writes the encrypted database: gzip, then age-encrypt, then split into numbered files.
// For --db data/users.db.age the files are data/users.db.age.000, .001, ... so no file passes the 2 GB limit
// on GitHub Release files. Join them in order and you have one age file. A single unsplit file is still readable.
// Everything is streamed: the plain database is over 2 GiB, which Node can't hold in one buffer or read in one call.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Encrypter, Decrypter, identityToRecipient } from "age-encryption";

export const DEFAULT_PART_MB = 1900;

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

async function* joinFiles(files) {
  for (const f of files) yield* fs.createReadStream(f);
}

// Decrypts the database into the plain SQLite file at outFile.
export async function readEncryptedDb(dbPath, identity, outFile) {
  const parts = partFiles(dbPath);
  const files = parts.length ? parts : [dbPath];
  const d = new Decrypter();
  d.addIdentity(identity);
  const plain = Readable.fromWeb(await d.decrypt(Readable.toWeb(Readable.from(joinFiles(files)))));
  const it = plain[Symbol.asyncIterator]();
  const first = await it.next(); // peek: older copies weren't compressed, so gunzip only if the gzip header is there
  const bytes = (async function* () { if (!first.done) yield first.value; yield* { [Symbol.asyncIterator]: () => it }; })();
  const isGzip = !first.done && first.value[0] === 0x1f && first.value[1] === 0x8b;
  const out = fs.createWriteStream(outFile, { mode: 0o600 });
  await (isGzip ? pipeline(bytes, zlib.createGunzip(), out) : pipeline(bytes, out));
}

// Encrypts the plain SQLite file at plainFile. Returns how many files were written.
export async function writeEncryptedDb(dbPath, identity, plainFile, partMb = DEFAULT_PART_MB) {
  const partBytes = Math.floor(partMb * 1024 * 1024);
  if (!(partBytes > 0)) throw new Error("part size must be positive");
  const e = new Encrypter();
  e.addRecipient(await identityToRecipient(identity));
  const gz = fs.createReadStream(plainFile).pipe(zlib.createGzip());
  gz.on("error", () => {}); // the error reaches the reader below
  const out = await e.encrypt(Readable.toWeb(gz));

  const old = partFiles(dbPath);
  if (fs.existsSync(dbPath)) old.push(dbPath);
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const written = new Set();
  let fd = null;
  let used = 0;
  const partName = (i) => path.join(dir, `${path.basename(dbPath)}.${String(i).padStart(3, "0")}`);
  const closePart = () => { if (fd !== null) { fs.closeSync(fd); fd = null; } };
  try {
    for await (const chunk of out) {
      for (let offset = 0; offset < chunk.length;) {
        if (fd === null || used >= partBytes) {
          closePart();
          const file = partName(written.size);
          fd = fs.openSync(file, "w");
          written.add(file);
          used = 0;
        }
        const n = Math.min(chunk.length - offset, partBytes - used);
        fs.writeSync(fd, chunk, offset, n);
        offset += n;
        used += n;
      }
    }
  } finally {
    closePart();
  }
  for (const f of old) if (!written.has(f)) fs.rmSync(f); // never leave a stale part to be joined later
  return written.size;
}
