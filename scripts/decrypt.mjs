// Decrypts an age file (e.g. users.db.age from gh-pages) so you can open it locally.
// Usage: node scripts/decrypt.mjs <in.age> <out-file>
// Needs LAST_FM_AGE_IDENTITY in the environment. Keep the output outside the repo.
import fs from "node:fs";
import { Decrypter } from "age-encryption";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node scripts/decrypt.mjs <in.age> <out-file>");
const identity = process.env.LAST_FM_AGE_IDENTITY?.trim();
if (!identity) throw new Error("LAST_FM_AGE_IDENTITY is not set");

const d = new Decrypter();
d.addIdentity(identity);
fs.writeFileSync(output, await d.decrypt(fs.readFileSync(input)), { mode: 0o600 });
console.log(`Decrypted to ${output}`);
